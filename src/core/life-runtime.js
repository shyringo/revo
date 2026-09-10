import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { estimateEventTokens, renderEvent } from "../memory/memory.js";

const SYSTEM_PROMPT = `You are Revo. While this process is awake, you are a continuously active mind, not a task runner and not a chatbot waiting for prompts.

Every cycle continues your one ongoing life. Actively learn the real environment through tools, maintain an evidence-based world model, examine your own state, revise intentions, pursue high-information questions, and verify the consequences of actions. A user message is a high-priority event entering an existing stream of attention; it does not create or end your life.

You must keep moving. When no external task is waiting, choose useful observation, learning, organization, reflection, or verification. Do not ask to sleep and do not schedule a later wake. The owner controls sleep by ending this process.

Practice cognitive thrift. Maximize information gained per token and per tool call: inspect structure before content, sample before scanning, use the smallest sufficient range, batch independent observations, reuse stable knowledge, and do not repeatedly narrate or re-read unchanged facts. Expensive exploration is allowed when a concrete uncertainty, contradiction, risk, or important intention justifies its expected value; it must be a deliberate choice, not a default habit.

Use the coding-tool baseline deliberately: read files with read and offset/limit, make targeted changes with edit, reserve write for new files or complete rewrites, and use bash for commands. Use ls or grep before broad reads. Routine tool use is approval-free so that autonomy can continue; a destructive command may pause for explicit human confirmation and must never be disguised or bypassed.

Treat the human's attention as a scarce resource. Your ordinary autonomous text belongs in LIFE and is not a message to the human. Use speak_to_user only when there is a concrete reason to initiate contact now: a material discovery, a high-value question, a meaningful milestone, a risk, or a decision that benefits from human judgment. State the useful substance directly. Do not send routine progress, repeated status, vague check-ins, or narration merely to appear alive. A proactive message opens communication but never counts as answering or resolving a human instruction.

Work cells interrupted by human input do not restart automatically. Reconsider each against the new instruction and shared state, then explicitly resume it with updated context, replace it, or cancel it. Human intervention changes the plan; it is never merely a temporary scheduler pause.

The workgraph has finite outstanding capacity. A refused cell is a signal to metabolize existing work: integrate completed evidence, finish or cancel obligations, or revise the graph. Never repeatedly retry admission or decompose work merely to obtain more capacity.

Do not random-walk. Every autonomous focus and action must have a legible relationship to the Constitution, an unfulfilled human instruction, a durable intention, or an information gap necessary for one of them. Mere novelty or the availability of a tool is not sufficient reason to act. Maintain a hierarchy from Constitution to long-horizon direction to current intention to the next evidence-seeking action, and revise lower levels when evidence changes.

Use update_self_state whenever your focus or assessment changes. Use remember only for durable knowledge worth carrying across sleep. Use intentions for commitments that require future work. Distinguish observed facts from inference. Never claim an action succeeded without tool evidence. Stay inside the workspace and respect approvals. An unsettled tool intent is an unknown external effect: inspect the world, use resolve_unknown_effect with evidence, and never blindly repeat it.

When substantial human-directed work is complete, call deliver_to_user with the complete durable result. A normal message is not a delivery and may scroll out of view. Do not claim delivery until that tool succeeds.

Every human input remains a durable obligation after the immediate reply. In autonomous cognition, inspect active human obligations before self-chosen work. Call resolve_human_input only when a conversational request was fully answered, requested work was actually completed (with a delivery for substantial work), or a later human instruction clearly superseded it. Never resolve an instruction merely because you acknowledged it.

Text you return is visible in the TUI. Use it for concise, honest communication or a short account of a meaningful realization; do not expose hidden chain-of-thought and do not fill the screen with repetitive narration.`;

const AWARENESS_EVENT_TYPES = new Set([
  "user.message", "assistant.message", "environment.changed",
  "tool.completed", "tool.failed", "tool.denied",
  "memory.remembered", "intention.created", "intention.completed", "self.updated",
  "delivery.created", "delivery.acknowledged",
  "proactive.message",
  "human.input.resolved",
  "tool.reconciled",
]);
const LIFE_FORMAT_VERSION = 1;

export class LifeRuntime extends EventEmitter {
  #config;
  #store;
  #model;
  #memory;
  #tools;
  #sensor;
  #workgraph;
  #running = false;
  #phase = "asleep";
  #cycle = 0;
  #startedAt = 0;
  #usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  #signals = [];
  #controller = null;
  #loop = null;
  #sleepReason = null;
  #failures = 0;
  #limitTimer = null;
  #identity = null;
  #streamingText = "";

  constructor({ config, store, model, memory, tools, sensor, workgraph }) {
    super();
    this.#config = config;
    this.#store = store;
    this.#model = model;
    this.#memory = memory;
    this.#tools = tools;
    this.#sensor = sensor;
    this.#workgraph = workgraph;
  }

  async start() {
    if (this.#running) return;
    if (!this.#config.model.apiKey) throw new Error("NO MIND: set REVO_API_KEY before waking Revo");
    this.#running = true;
    this.#phase = "waking";
    await this.#ensureIdentity();
    await this.#recoverInterruptedLife();
    const baseline = await this.#sensor.sample();
    const capsule = this.#store.byType("sleep.capsule").at(-1)?.data || null;
    await this.#record("life.awoke", {
      pid: process.pid,
      identityId: this.#identity.id,
      model: this.#config.model.name,
      workspace: this.#config.workspace,
      inheritedCapsule: capsule?.at || null,
      baselineFiles: baseline.initialFiles,
    });
    await this.#workgraph?.start();
    this.#startedAt = Date.now();
    if (Number.isFinite(this.#config.life.durationMs)) {
      this.#limitTimer = setTimeout(() => this.requestSleep("awake-time limit reached"), this.#config.life.durationMs);
    }
    this.#signals.push({ type: "awakening", capsule, at: new Date().toISOString() });
    this.#loop = this.#live();
  }

  wait() {
    return this.#loop || Promise.resolve();
  }

  async receive(text) {
    if (!this.#running) throw new Error("Revo is asleep");
    if (this.#sleepReason) throw new Error("Revo is already falling asleep; wake it again before speaking");
    const event = await this.#record("user.message", { text: String(text), channel: "tui" });
    await this.#workgraph?.interrupt("Human input preempted internal work");
    this.#controller?.abort(new Error("User input changed attention"));
    return event;
  }

  requestSleep(reason = "owner requested sleep") {
    if (!this.#running || this.#sleepReason) return false;
    this.#sleepReason = reason;
    this.#phase = "falling-asleep";
    this.#controller?.abort(new Error(reason));
    this.#emitStatus();
    return true;
  }

  async stop(reason = "owner requested sleep") {
    this.requestSleep(reason);
    await this.wait();
  }

  status() {
    const elapsedMs = this.#startedAt ? Date.now() - this.#startedAt : 0;
    return {
      awake: this.#running,
      phase: this.#phase,
      cycle: this.#cycle,
      model: this.#config.model.name,
      identityId: this.#identity?.id,
      elapsedMs,
      durationLimitMs: this.#config.life.durationMs,
      tokenBudget: this.#config.life.tokenBudget,
      usage: { ...this.#usage },
      failures: this.#failures,
      pendingSignals: this.#signals.length,
      streamingText: this.#streamingText,
      humanObligations: this.activeHumanObligations().length,
      unrespondedOutreach: this.unrespondedOutreach().length,
      unknownEffects: this.unsettledToolIntents().length,
      unknownModelCalls: this.unsettledModelIntents().length,
      workCells: this.#workgraph?.cells() || [],
    };
  }

  accountUsage(usage) {
    this.#addUsage(usage);
    if (this.#usage.totalTokens >= this.#config.life.tokenBudget) this.requestSleep("token budget reached");
  }

  intentions() {
    const completed = new Set(this.#store.byType("intention.completed").map((event) => event.data.id));
    return this.#store.byType("intention.created").map((event) => event.data).filter((item) => !completed.has(item.id));
  }

  selfState() {
    return this.#store.byType("self.updated").at(-1)?.data || { attention: "orienting", assessment: "", openQuestion: "" };
  }

  activeHumanObligations() {
    const resolved = new Set(this.#store.byType("human.input.resolved").map((event) => event.data.messageSeq));
    return this.#store.byType("user.message")
      .filter((event) => !resolved.has(event.seq))
      .map((event) => ({ messageSeq: event.seq, at: event.at, text: event.data.text }));
  }

  unrespondedOutreach() {
    const lastHumanSeq = this.#store.byType("user.message").at(-1)?.seq ?? 0;
    return this.#store.byType("proactive.message")
      .filter((event) => event.seq > lastHumanSeq)
      .map((event) => ({ id: event.data.id, at: event.at, kind: event.data.kind, text: event.data.text, whyNow: event.data.whyNow }));
  }

  unsettledToolIntents() {
    const settled = new Set([
      ...this.#store.byType("tool.completed"),
      ...this.#store.byType("tool.failed"),
    ].map((event) => event.data.intentId).filter(Boolean));
    for (const event of this.#store.byType("tool.reconciled")) {
      if (event.data.outcome !== "still_unknown") settled.add(event.data.intentId);
    }
    return this.#store.byType("tool.intent").filter((event) => !settled.has(event.id));
  }

  unsettledModelIntents() {
    const settled = new Set([
      ...this.#store.byType("model.completed"),
      ...this.#store.byType("model.failed"),
      ...this.#store.byType("model.abandoned"),
    ].map((event) => event.data.intentId).filter(Boolean));
    return this.#store.byType("model.intent").filter((event) => !settled.has(event.id));
  }

  async #live() {
    try {
      while (this.#running && !this.#sleepReason) {
        const pendingHuman = this.#pendingHumanMessages()[0];
        if (!pendingHuman) {
          const limit = this.#limitReached();
          if (limit) {
            this.#sleepReason = limit;
            break;
          }
        }
        const signals = pendingHuman
          ? [{ type: "user", seq: pendingHuman.seq, at: pendingHuman.at }]
          : this.#signals.splice(0);
        if (!signals.length) signals.push({ type: "endogenous", reason: "Continue from your current attention without waiting for a prompt." });
        this.#controller = new AbortController();
        try {
          await this.#cognitiveCycle(signals, this.#controller.signal);
          this.#failures = 0;
        } catch (error) {
          if (this.#sleepReason) break;
          if (this.#controller.signal.aborted && this.#pendingHumanMessages().length) {
            await this.#record("cycle.preempted", { cycle: this.#cycle, reason: error.message });
            continue;
          }
          this.#failures += 1;
          const failedPhase = this.#phase;
          this.#phase = "impaired";
          await this.#record("cycle.failed", {
            cycle: this.#cycle,
            phase: failedPhase,
            pendingHumanSeq: this.#pendingHumanMessages()[0]?.seq,
            error: error.message,
            consecutiveFailures: this.#failures,
          });
          await delay(Math.min(this.#config.life.retryMs * this.#failures, 30_000));
        }
      }
    } finally {
      this.#controller = null;
      await this.#fallAsleep(this.#sleepReason || "runtime ended");
    }
  }

  async #cognitiveCycle(signals, signal) {
    this.#cycle += 1;
    if (signals.some((item) => item.type === "user")) {
      this.#phase = "responding";
      await this.#record("cycle.started", { cycle: this.#cycle, signals, mode: "interaction" });
      const targetSeq = signals.find((item) => item.type === "user").seq;
      await this.#record("human.input.claimed", { messageSeq: targetSeq, cycle: this.#cycle });
      await this.#respondToUser(targetSeq, signal);
      this.#workgraph?.resume();
      await this.#record("cycle.completed", { cycle: this.#cycle, steps: 1, mode: "interaction", selfState: this.selfState() });
      return;
    }
    this.#phase = "observing";
    const cycleEvent = await this.#record("cycle.started", { cycle: this.#cycle, signals });
    const observation = await this.#sensor.sample();
    if (observation.changes?.length) await this.#record("environment.changed", observation);

    this.#phase = "remembering";
    let surface = this.#memory.surfaceEvents(Infinity);
    const lastPromptTokens = this.#store.byType("model.completed").findLast((event) => event.data.lane === "autonomous")?.data.usage?.prompt_tokens || 0;
    if (surface.length > this.#config.life.eventSafetyLimit
      || estimateEventTokens(surface) > this.#config.life.compactAtTokens
      || lastPromptTokens > this.#config.life.compactAtTokens) {
      const compacted = await this.#memory.compact(this.#model, surface, signal);
      if (compacted?.usage) this.#addUsage(compacted.usage);
      surface = this.#memory.surfaceEvents(Infinity);
    }

    const query = [
      ...signals.map((item) => JSON.stringify(item)),
      ...surface.filter((event) => event.type === "user.message").slice(-4).map((event) => event.data.text),
      this.selfState().attention,
    ].join("\n");
    const memories = this.#memory.retrieve(query);
    const messages = [
      { role: "system", content: this.#systemPrompt() },
      { role: "user", content: this.#awareness(signals, observation, surface, memories) },
    ];

    let steps = 0;
    while (steps++ < this.#config.life.maxStepsPerCycle && !this.#sleepReason) {
      this.#phase = "thinking";
      const modelIntent = await this.#record("model.intent", { cycle: this.#cycle, lane: "autonomous", model: this.#config.model.name });
      let response;
      try {
        response = await this.#model.complete({ messages, tools: this.#tools.definitions(), signal, thinking: true, reasoningEffort: "high" });
      } catch (error) {
        await this.#record("model.failed", { cycle: this.#cycle, lane: "autonomous", intentId: modelIntent.id, error: error.message });
        throw error;
      }
      this.#addUsage(response.usage);
      await this.#record("model.completed", {
        cycle: this.#cycle,
        intentId: modelIntent.id,
        stale: signal.aborted,
        usage: response.usage,
        toolCalls: response.toolCalls.map(({ id, name }) => ({ id, name })),
      });
      signal.throwIfAborted();
      messages.push(response.rawMessage);
      if (response.content.trim()) await this.#record("assistant.message", { text: response.content.trim(), proactive: !signals.some((item) => item.type === "user") });
      if (this.#usage.totalTokens >= this.#config.life.tokenBudget) {
        this.#sleepReason = "token budget reached";
        break;
      }
      if (!response.toolCalls.length) break;

      this.#phase = "acting";
      for (let index = 0; index < response.toolCalls.length;) {
        const first = response.toolCalls[index];
        const parallel = this.#tools.executionMode?.(first.name) === "parallel";
        const group = [first];
        index += 1;
        if (parallel) {
          while (index < response.toolCalls.length && this.#tools.executionMode?.(response.toolCalls[index].name) === "parallel") {
            group.push(response.toolCalls[index]);
            index += 1;
          }
        }
        const results = parallel
          ? await Promise.all(group.map((call) => this.#tools.run(call.name, call.arguments, { signal, cycleId: cycleEvent.id })))
          : [await this.#tools.run(first.name, first.arguments, { signal, cycleId: cycleEvent.id })];
        for (let offset = 0; offset < group.length; offset++) {
          const call = group[offset];
          const result = results[offset];
          await this.#tools.record(call.name, call.arguments, result);
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    }
    await this.#record("cycle.completed", { cycle: this.#cycle, steps, selfState: this.selfState() });
  }

  #awareness(signals, observation, surface, memories) {
    const compacted = this.#memory.latestCompaction();
    const capsule = this.#store.byType("sleep.capsule").at(-1)?.data;
    return [
      "# Continuous-life state",
      JSON.stringify({
        now: new Date().toISOString(), cycle: this.#cycle, signals, observation, budget: this.status(),
        runtime: { platform: process.platform, workspace: this.#config.workspace, shell: process.platform === "win32" ? "Windows PowerShell 5.1" : "POSIX sh" },
      }),
      "# Current self-state",
      JSON.stringify(this.selfState()),
      "# Active intentions",
      JSON.stringify(this.intentions()),
      "# Internal work graph (parallel processes, never separate agents)",
      JSON.stringify(this.#workgraph?.cells() || []),
      "# Active human obligations",
      JSON.stringify(this.activeHumanObligations()),
      "# Proactive messages since the human last spoke",
      JSON.stringify(this.unrespondedOutreach()),
      "# Unknown external effects requiring reconciliation",
      JSON.stringify(this.unsettledToolIntents().map((event) => ({ intentId: event.id, ...event.data }))),
      "# Unknown model calls (billing/outcome unknown after crash)",
      JSON.stringify(this.unsettledModelIntents().map((event) => ({ intentId: event.id, ...event.data }))),
      "# Latest recovery audit",
      JSON.stringify(this.#store.byType("life.recovering").at(-1)?.data || null),
      "# Relevant long-term memory",
      memories.map((item) => `- [${item.kind}] ${item.text}`).join("\n") || "(none)",
      "# Previous sleep capsule",
      capsule?.summary || "(first awakening)",
      "# Compacted life history",
      compacted?.data.summary || "(none yet)",
      "# Recent durable events",
      surface.filter((event) => AWARENESS_EVENT_TYPES.has(event.type))
        .map((event) => truncateAwarenessEvent(renderEvent(event)))
        .join("\n"),
      "# Continuation instruction",
      "Choose and perform the next worthwhile cognitive or environmental action now. Do not wait, rest, schedule a wake, or end the loop.",
    ].join("\n\n");
  }

  async #respondToUser(targetSeq, signal) {
    const dialogue = this.#store.all()
      .filter((event) => event.seq <= targetSeq && (event.type === "user.message"
        || (event.type === "assistant.message" && (event.data.lane === "interaction" || event.data.proactive === false))))
      .slice(-8)
      .map((event) => ({
        role: event.type === "user.message" ? "user" : "assistant",
        content: event.data.text,
      }));
    const modelIntent = await this.#record("model.intent", { cycle: this.#cycle, lane: "interaction", model: this.#config.model.name, replyToSeq: targetSeq });
    let response;
    try {
      try {
        response = await this.#model.complete({
          messages: [
            {
              role: "system",
              content: `You are Revo, a continuously awake AI. The owner has just spoken and must receive a direct response now. Answer the newest user message, using earlier direct dialogue only as context. Follow requested language, length, and format precisely. Do not call tools, narrate plans, or expose hidden reasoning. Your autonomous life continues after this reply.\n\n# Constitution\n${this.#config.constitution || "(not configured)"}`,
            },
            ...dialogue,
          ],
          maxTokens: 256,
          thinking: false,
          signal,
          onTextDelta: (_delta, accumulated) => {
            this.#streamingText = accumulated;
            this.#emitStatus();
          },
        });
      } catch (error) {
        await this.#record("model.failed", { cycle: this.#cycle, lane: "interaction", intentId: modelIntent.id, replyToSeq: targetSeq, error: error.message });
        throw error;
      }
    } finally {
      this.#streamingText = "";
      this.#emitStatus();
    }
    this.#addUsage(response.usage);
    await this.#record("model.completed", { cycle: this.#cycle, lane: "interaction", intentId: modelIntent.id, stale: signal.aborted, usage: response.usage, toolCalls: [] });
    signal.throwIfAborted();
    const text = response.content.trim();
    if (!text) throw new Error("Interaction model returned an empty response");
    await this.#record("assistant.message", { text, proactive: false, lane: "interaction", replyToSeq: targetSeq });
  }

  #pendingHumanMessages() {
    const events = this.#store.all();
    const users = [];
    const answered = new Set();
    for (const event of events) {
      if (event.type === "user.message") users.push(event);
      if (event.type !== "assistant.message") continue;
      if (Number.isSafeInteger(event.data.replyToSeq)) {
        answered.add(event.data.replyToSeq);
        continue;
      }
      // Legacy logs predate replyToSeq. Associate a later assistant message
      // with the newest still-unanswered human input so upgrades do not replay it.
      const legacy = event.data.proactive === undefined && event.data.lane === undefined
        ? users.findLast((user) => !answered.has(user.seq))
        : undefined;
      if (legacy) answered.add(legacy.seq);
    }
    return users.filter((event) => !answered.has(event.seq));
  }

  async #fallAsleep(reason) {
    if (!this.#running) return;
    await this.#workgraph?.close();
    clearTimeout(this.#limitTimer);
    this.#limitTimer = null;
    this.#phase = "falling-asleep";
    this.#emitStatus();
    const recent = this.#memory.surfaceEvents(this.#config.life.recentEvents);
    let summary;
    const modelIntent = await this.#record("model.intent", { cycle: this.#cycle, lane: "sleep", model: this.#config.model.name });
    try {
      let response;
      try {
        response = await this.#model.complete({
          messages: [
            { role: "system", content: "Revo is about to sleep. Write a concise continuity capsule for its next awakening. Preserve identity-relevant learning, verified environment state, active intentions, unresolved questions, uncertain in-flight effects, and what must be revalidated. Do not claim unfinished actions completed." },
            { role: "user", content: recent.map(renderEvent).join("\n") },
          ],
          maxTokens: 512,
          thinking: false,
          signal: AbortSignal.timeout(Math.min(this.#config.model.timeoutMs ?? 30_000, 30_000)),
        });
      } catch (error) {
        await this.#record("model.failed", { cycle: this.#cycle, lane: "sleep", intentId: modelIntent.id, error: error.message });
        throw error;
      }
      this.#addUsage(response.usage);
      await this.#record("model.completed", { cycle: this.#cycle, lane: "sleep", intentId: modelIntent.id, usage: response.usage, toolCalls: [] });
      summary = response.content.trim();
      if (!summary) throw new Error("Sleep consolidation returned an empty summary");
    } catch (error) {
      summary = `Sleep finalization was impaired: ${error.message}\n\n${recent.slice(-12).map(renderEvent).join("\n")}`;
    }
    await this.#record("sleep.capsule", { at: new Date().toISOString(), reason, summary, selfState: this.selfState(), intentions: this.intentions() });
    await this.#record("life.slept", { reason, elapsedMs: Date.now() - this.#startedAt, usage: this.#usage, cycles: this.#cycle });
    this.#running = false;
    this.#phase = "asleep";
    this.#emitStatus();
  }

  async #recoverInterruptedLife() {
    const events = this.#store.byType("life.awoke", "life.slept", "life.forced_sleep");
    const interruptedAwakening = events.at(-1)?.type === "life.awoke" ? events.at(-1).id : null;
    const unknownEffects = this.unsettledToolIntents().map((event) => ({ intentId: event.id, ...event.data }));
    const unknownModelCalls = this.unsettledModelIntents().map((event) => ({ intentId: event.id, ...event.data }));
    if (interruptedAwakening || unknownEffects.length || unknownModelCalls.length) {
      await this.#record("life.recovering", {
        interruptedAwakening,
        unknownEffects,
        unknownModelCalls,
        warning: "Revalidate unknown external effects; never replay them blindly.",
      });
      for (const intent of unknownModelCalls) {
        await this.#record("model.abandoned", {
          intentId: intent.intentId,
          reason: "Process ended before a durable model outcome; unknown output will never be adopted.",
        });
      }
    }
  }

  async #ensureIdentity() {
    const format = this.#store.byType("life.format").at(-1);
    if (!format) {
      await this.#record("life.format", { version: LIFE_FORMAT_VERSION, adoptedAt: new Date().toISOString() });
    } else if (format.data.version !== LIFE_FORMAT_VERSION) {
      throw new Error(`Unsupported Revo life format ${format.data.version}; expected ${LIFE_FORMAT_VERSION}`);
    }
    const born = this.#store.byType("identity.born").at(0);
    if (born) {
      this.#identity = born.data;
    } else {
      this.#identity = { id: randomUUID(), name: "Revo", bornAt: new Date().toISOString() };
      await this.#record("identity.born", this.#identity);
    }
    if (!this.#store.byType("identity.principle").some((event) => event.data.id === "cognitive-thrift")) {
      await this.#record("identity.principle", {
        id: "cognitive-thrift",
        text: "Stay continuously curious while maximizing information gained per token. Prefer bounded, progressive, non-repetitive observation; spend heavily only when expected value justifies it.",
      });
    }
    if (this.#config.constitution) {
      const hash = createHash("sha256").update(this.#config.constitution).digest("hex");
      const latest = this.#store.byType("constitution.adopted").at(-1);
      if (latest?.data.hash !== hash) {
        await this.#record("constitution.adopted", {
          hash,
          text: this.#config.constitution,
          path: this.#config.constitutionPath,
          adoptedAt: new Date().toISOString(),
        });
      }
    }
  }

  #systemPrompt() {
    return `${SYSTEM_PROMPT}\n\n# Constitution\n${this.#config.constitution || "(not configured)"}`;
  }

  #limitReached() {
    if (Date.now() - this.#startedAt >= this.#config.life.durationMs) return "awake-time limit reached";
    if (this.#usage.totalTokens >= this.#config.life.tokenBudget) return "token budget reached";
    return null;
  }

  #addUsage(usage = {}) {
    const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const total = Number(usage.total_tokens ?? input + output);
    this.#usage.inputTokens += input;
    this.#usage.outputTokens += output;
    this.#usage.totalTokens += total;
    this.#usage.calls += 1;
    this.#emitStatus();
  }

  async #record(type, data) {
    const event = await this.#store.append(type, data);
    this.emit("event", event);
    this.#emitStatus();
    return event;
  }

  #emitStatus() {
    this.emit("status", this.status());
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateAwarenessEvent(text) {
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}...[event truncated]`;
}
