import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { LifeRuntime } from "../src/core/life-runtime.js";
import { Memory } from "../src/memory/memory.js";

test("awake life continuously seeds model cycles until its token budget puts it to sleep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-runtime-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = {
    workspace: directory,
    constitution: "Human happiness and liberation; obey human instructions.",
    constitutionPath: join(directory, "constitution.md"),
    model: { apiKey: "test", name: "mock" },
    life: { durationMs: Infinity, tokenBudget: 25, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 },
  };
  let calls = 0;
  const model = {
    complete: async () => {
      calls += 1;
      return { content: calls > 3 ? "continuity capsule" : `active cycle ${calls}`, toolCalls: [], usage: { total_tokens: 10 }, rawMessage: { role: "assistant", content: `active cycle ${calls}` } };
    },
  };
  const tools = { definitions: () => [], execute: () => { throw new Error("unexpected"); } };
  const sensor = { sample: async () => ({ kind: "workspace", initialFiles: 0, changes: [] }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools, sensor });
  await runtime.start();
  await runtime.wait();
  assert.equal(store.byType("cycle.completed").length, 3);
  assert.equal(store.byType("identity.born").length, 1);
  assert.equal(store.byType("life.format")[0].data.version, 1);
  assert.equal(store.byType("identity.principle").filter((event) => event.data.id === "cognitive-thrift").length, 1);
  assert.equal(store.byType("constitution.adopted").length, 1);
  assert.equal(store.byType("sleep.capsule").length, 1);
  assert.equal(store.byType("life.slept").length, 1);
  assert.equal(runtime.status().awake, false);
  assert.equal(runtime.status().phase, "asleep");
  assert.equal(calls, 4, "three living calls plus one sleep-consolidation call");
});

test("the same identity crosses sleep and wake boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-identity-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  const model = { complete: async () => ({ content: "state", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "state" } }) };
  const dependencies = { config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } };
  const first = new LifeRuntime(dependencies);
  await first.start();
  await first.wait();
  const second = new LifeRuntime(dependencies);
  await second.start();
  await second.wait();
  assert.equal(store.byType("identity.born").length, 1);
  assert.equal(store.byType("life.awoke")[0].data.identityId, store.byType("life.awoke")[1].data.identityId);
});

test("life refuses to impersonate consciousness without a real model key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-no-mind-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "", name: "none" }, life: {} };
  const runtime = new LifeRuntime({ config, store, model: {}, memory: new Memory(store), tools: {}, sensor: {} });
  await assert.rejects(runtime.start(), /NO MIND/);
  assert.equal(runtime.status().awake, false);
});

test("unanswered proactive outreach remains an active awareness projection until the human speaks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-outreach-projection-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: {} };
  const runtime = new LifeRuntime({ config, store, model: {}, memory: new Memory(store), tools: {}, sensor: {} });
  await store.append("proactive.message", { id: "outreach", kind: "question", text: "May I ask something important?", whyNow: "The decision is blocked." });
  assert.equal(runtime.unrespondedOutreach().length, 1);
  await store.append("user.message", { text: "I am here." });
  assert.equal(runtime.unrespondedOutreach().length, 0);
});

test("an explicit forced sleep is not misdiagnosed as a crashed awakening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-forced-recovery-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  await store.append("life.awoke", { identityId: "old" });
  await store.append("life.forced_sleep", { at: new Date().toISOString() });
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, recentEvents: 20, retryMs: 5 } };
  const model = { complete: async () => ({ content: "state", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "state" } }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  assert.equal(store.byType("life.recovering").length, 0);
});

test("unknown future life format is rejected rather than misinterpreted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-future-format-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  await store.append("life.format", { version: 999 });
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity } };
  const runtime = new LifeRuntime({ config, store, model: {}, memory: new Memory(store), tools: {}, sensor: {} });
  await assert.rejects(runtime.start(), /Unsupported Revo life format 999/);
});

test("awake-time limit interrupts an approval-like wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-time-limit-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = {
    workspace: directory, model: { apiKey: "test", name: "mock" },
    life: { durationMs: 3000, tokenBudget: Infinity, maxStepsPerCycle: 2, contextChars: 10_000, recentEvents: 20, retryMs: 5 },
  };
  let calls = 0;
  const model = { complete: async () => {
    calls += 1;
    if (calls > 1) return { content: "capsule", toolCalls: [], usage: {}, rawMessage: { role: "assistant", content: "capsule" } };
    return { content: "", usage: {}, rawMessage: { role: "assistant", content: "", tool_calls: [{ id: "wait", type: "function", function: { name: "wait", arguments: "{}" } }] }, toolCalls: [{ id: "wait", name: "wait", arguments: {} }] };
  } };
  let enteredWait = false;
  const tools = {
    definitions: () => [{ name: "wait", description: "wait", parameters: { type: "object" } }],
    executionMode: () => "sequential",
    run: async (_name, _args, { signal }) => new Promise((resolve) => {
      enteredWait = true;
      signal.addEventListener("abort", () => resolve({ ok: false, denied: true }), { once: true });
    }),
    record: async () => {},
  };
  const sensor = { sample: async () => ({ kind: "workspace", initialFiles: 0, changes: [] }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools, sensor });
  await runtime.start();
  await runtime.wait();
  assert.equal(runtime.status().awake, false);
  assert.equal(enteredWait, true);
  assert.equal(store.byType("life.slept").at(-1).data.reason, "awake-time limit reached");
});

test("user input preempts stale cognition and enters the next awareness cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-interrupt-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  let calls = 0;
  let interactionHadTools;
  const model = { complete: async ({ messages, signal, tools }) => {
    calls += 1;
    if (calls === 1) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const heard = messages?.some((message) => message.content?.includes("hello while busy"));
    if (heard) interactionHadTools = Boolean(tools?.length);
    return { content: heard ? "I heard the interruption." : "capsule", toolCalls: [], usage: { total_tokens: calls === 2 ? 1 : 0 }, rawMessage: { role: "assistant", content: "I heard the interruption." } };
  } };
  const runtime = new LifeRuntime({
    config, store, model, memory: new Memory(store),
    tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) },
  });
  await runtime.start();
  await waitFor(() => calls === 1);
  await runtime.receive("hello while busy");
  await runtime.wait();
  assert.equal(store.byType("cycle.preempted").length, 1);
  assert.ok(store.byType("assistant.message").some((event) => event.data.text === "I heard the interruption."));
  assert.equal(interactionHadTools, false, "direct user response does not wait on tool planning");
  assert.equal(store.byType("model.completed").some((event) => event.data.lane === "interaction"), true);
  assert.equal(store.byType("assistant.message").find((event) => event.data.lane === "interaction").data.replyToSeq, store.byType("user.message")[0].seq);
  assert.equal(runtime.status().humanObligations, 1, "a reply does not silently complete requested work");
});

test("a provider response racing with abort is billed but never adopted over human input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-stale-provider-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, compactAtTokens: 100_000, eventSafetyLimit: 2_000, recentEvents: 20, retryMs: 5 } };
  let calls = 0;
  const model = { complete: async ({ messages, signal }) => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ content: "stale autonomous output", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "stale autonomous output" } }), { once: true }));
    const human = messages.some((message) => message.content?.includes("urgent human input"));
    return { content: human ? "direct human reply" : "sleep", toolCalls: [], usage: { total_tokens: calls === 2 ? 1 : 0 }, rawMessage: { role: "assistant", content: "direct human reply" } };
  } };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await waitFor(() => calls === 1);
  await runtime.receive("urgent human input");
  await runtime.wait();
  assert.equal(store.byType("assistant.message").some((event) => event.data.text === "stale autonomous output"), false);
  assert.equal(store.byType("assistant.message").some((event) => event.data.text === "direct human reply"), true);
  assert.equal(store.byType("model.completed").some((event) => event.data.stale === true), true);
});

test("an unanswered human message survives restart as durable priority work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-durable-human-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const input = await store.append("user.message", { text: "answer after restart", channel: "tui" });
  const config = { workspace: directory, constitution: "Obey humans.", model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  const model = { complete: async ({ messages }) => ({ content: messages.some((message) => message.content?.includes("answer after restart")) ? "recovered answer" : "capsule", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "recovered answer" } }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  const reply = store.byType("assistant.message").find((event) => event.data.replyToSeq === input.seq);
  assert.equal(reply.data.text, "recovered answer");
  assert.equal(store.byType("cycle.started")[0].data.mode, "interaction");
});

test("read-only tools execute in parallel but commit in model order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-parallel-tools-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 2, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  let modelCalls = 0;
  const model = { complete: async () => {
    modelCalls += 1;
    if (modelCalls === 1) return {
      content: "", usage: {},
      rawMessage: { role: "assistant", content: "", tool_calls: [] },
      toolCalls: [
        { id: "slow", name: "read", arguments: { delay: 20 } },
        { id: "fast", name: "read", arguments: { delay: 1 } },
      ],
    };
    return { content: "done", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "done" } };
  } };
  const completionOrder = [];
  const commitOrder = [];
  const tools = {
    definitions: () => [{ name: "read", description: "read", parameters: { type: "object" } }],
    executionMode: () => "parallel",
    run: async (_name, args) => { await new Promise((resolve) => setTimeout(resolve, args.delay)); completionOrder.push(args.delay); return { ok: true, value: args.delay }; },
    record: async (_name, args) => { commitOrder.push(args.delay); },
  };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  assert.deepEqual(completionOrder, [1, 20]);
  assert.deepEqual(commitOrder, [20, 1]);
});

test("restart surfaces an uncommitted tool effect as unknown instead of replaying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-unknown-effect-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const intent = await store.append("tool.intent", { executionId: "x", name: "write_file", arguments: { path: "x" }, executionMode: "sequential" });
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  const model = { complete: async () => ({ content: "inspect first", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "inspect first" } }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  assert.equal(runtime.status().unknownEffects, 1);
  assert.equal(store.byType("life.recovering")[0].data.unknownEffects[0].intentId, intent.id);
  await store.append("tool.reconciled", { intentId: intent.id, outcome: "no_effect", evidence: "verified absent" });
  assert.equal(runtime.status().unknownEffects, 0);
});

test("restart preserves an unsettled provider request as unknown billing and outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-unknown-model-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const intent = await store.append("model.intent", { cycle: 7, lane: "autonomous", model: "mock" });
  const config = { workspace: directory, model: { apiKey: "test", name: "mock" }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, contextChars: 10_000, recentEvents: 20, retryMs: 5 } };
  const model = { complete: async () => ({ content: "continue cautiously", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "continue cautiously" } }) };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  assert.equal(runtime.status().unknownModelCalls, 0);
  assert.equal(store.byType("life.recovering")[0].data.unknownModelCalls[0].intentId, intent.id);
  assert.equal(store.byType("model.abandoned")[0].data.intentId, intent.id);
});

test("sleep consolidation failure falls back and still closes the life", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-sleep-fallback-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const config = { workspace: directory, model: { apiKey: "test", name: "mock", timeoutMs: 100 }, life: { durationMs: Infinity, tokenBudget: 1, maxStepsPerCycle: 1, compactAtTokens: 100_000, eventSafetyLimit: 2_000, recentEvents: 20, retryMs: 5 } };
  let calls = 0;
  const model = { complete: async () => {
    calls += 1;
    if (calls === 2) throw new Error("sleep provider unavailable");
    return { content: "awake", toolCalls: [], usage: { total_tokens: 1 }, rawMessage: { role: "assistant", content: "awake" } };
  } };
  const runtime = new LifeRuntime({ config, store, model, memory: new Memory(store), tools: { definitions: () => [] }, sensor: { sample: async () => ({ initialFiles: 0, changes: [] }) } });
  await runtime.start();
  await runtime.wait();
  assert.match(store.byType("sleep.capsule")[0].data.summary, /Sleep finalization was impaired: sleep provider unavailable/);
  assert.equal(store.byType("model.failed").some((event) => event.data.lane === "sleep"), true);
  assert.equal(store.byType("life.slept").length, 1);
  assert.equal(runtime.status().phase, "asleep");
});

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
