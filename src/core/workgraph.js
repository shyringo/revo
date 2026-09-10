import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class WorkGraph extends EventEmitter {
  #store;
  #model;
  #config;
  #running = false;
  #queue = [];
  #active = new Map();
  #unsubscribe;
  #paused = false;

  constructor({ store, model, config }) {
    super();
    this.#store = store;
    this.#model = model;
    this.#config = config;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    for (const cell of this.cells().filter((item) => item.state === "running")) {
      await this.#store.append("work.cell.interrupted", { id: cell.id, error: "Process ended while this cell was running", at: new Date().toISOString(), recovered: true });
      await this.#store.append("work.cell.resumed", { id: cell.id, context: cell.context, at: new Date().toISOString(), recovered: true });
    }
    for (const cell of this.cells().filter((item) => item.state === "ready")) this.#enqueue(cell.id);
    this.#unsubscribe = this.#store.subscribe((event) => {
      if (event.type === "work.cell.opened") this.#enqueue(event.data.id);
    });
    this.#drain();
  }

  async close() {
    this.#running = false;
    this.#unsubscribe?.();
    for (const controller of this.#active.values()) controller.abort(new Error("Revo is sleeping"));
    await Promise.allSettled([...this.#active.values()].map((controller) => controller.done).filter(Boolean));
  }

  async interrupt(reason = "Human input preempted internal work") {
    this.#paused = true;
    for (const controller of this.#active.values()) controller.abort(new Error(reason));
  }

  resume() {
    this.#paused = false;
    for (const cell of this.cells().filter((item) => item.state === "ready")) this.#enqueue(cell.id);
    this.#drain();
  }

  async resumeCell(id, context = "") {
    const cell = this.cells().find((item) => item.id === id);
    if (!cell) throw new Error(`Unknown work cell: ${id}`);
    if (!["interrupted", "failed", "needs-revalidation"].includes(cell.state)) throw new Error(`Work cell ${id} is ${cell.state}, not resumable`);
    await this.#store.append("work.cell.resumed", { id, context: String(context).trim(), at: new Date().toISOString() });
    this.#enqueue(id);
    return { id, resumed: true };
  }

  async open({ objective, context = "", dependsOn = [], maxOutputTokens = 1200 }) {
    const cells = this.cells();
    const outstanding = cells.filter((cell) => !["completed", "cancelled"].includes(cell.state));
    const limit = Math.max(1, Math.min(100, Math.floor(this.#config.workgraph?.maxOutstanding ?? 12)));
    if (outstanding.length >= limit) {
      return {
        admitted: false,
        reason: "workgraph capacity reached; integrate, complete, or cancel existing work before opening more",
        outstanding: outstanding.length,
        limit,
        states: outstanding.reduce((counts, cell) => ({ ...counts, [cell.state]: (counts[cell.state] || 0) + 1 }), {}),
      };
    }
    const known = new Set(cells.map((cell) => cell.id));
    for (const dependency of dependsOn) if (!known.has(dependency)) throw new Error(`Unknown work-cell dependency: ${dependency}`);
    const data = {
      id: randomUUID(), objective: String(objective).trim(), context: String(context).trim(),
      dependsOn: [...new Set(dependsOn)], maxOutputTokens: Math.max(256, Math.min(4096, Math.floor(maxOutputTokens))),
      openedAt: new Date().toISOString(),
    };
    await this.#store.append("work.cell.opened", data);
    return { admitted: true, ...data };
  }

  async cancel(id, reason) {
    const cell = this.cells().find((item) => item.id === id);
    if (!cell) throw new Error(`Unknown work cell: ${id}`);
    await this.#store.append("work.cell.cancelled", { id, reason, at: new Date().toISOString() });
    this.#active.get(id)?.abort(new Error(`Work cell cancelled: ${reason}`));
    return { id, cancelled: true };
  }

  cells() {
    return projectWorkCells(this.#store);
  }

  #enqueue(id) {
    if (!this.#queue.includes(id) && !this.#active.has(id)) this.#queue.push(id);
    this.#drain();
  }

  #drain() {
    if (!this.#running || this.#paused) return;
    const limit = Math.max(1, Math.min(8, Math.floor(this.#config.workgraph?.maxConcurrency ?? 3)));
    while (this.#active.size < limit) {
      const index = this.#queue.findIndex((id) => this.cells().find((cell) => cell.id === id)?.state !== "blocked");
      if (index < 0) break;
      const [id] = this.#queue.splice(index, 1);
      const cell = this.cells().find((item) => item.id === id);
      if (!cell || ["completed", "cancelled"].includes(cell.state)) continue;
      const controller = new AbortController();
      this.#active.set(id, controller);
      controller.done = this.#run(cell, controller.signal).finally(() => {
        this.#active.delete(id);
        if (!this.#paused) for (const candidate of this.cells().filter((item) => item.state === "ready")) this.#enqueue(candidate.id);
        this.#drain();
      });
    }
  }

  async #run(cell, signal) {
    const started = await this.#store.append("work.cell.started", { id: cell.id, at: new Date().toISOString() });
    const intent = await this.#store.append("model.intent", { lane: "work-cell", cellId: cell.id, model: this.#config.model.name });
    let modelCompleted = false;
    let interrupted = false;
    try {
      const dependencies = this.cells().filter((item) => cell.dependsOn.includes(item.id)).map((item) => ({ objective: item.objective, output: item.output }));
      const response = await this.#model.complete({
        messages: [
          { role: "system", content: `You are a bounded parallel cognitive process within Revo, not another agent, persona, or conversational subject. Work only on the assigned objective. Produce a concise evidence-oriented result for Revo's shared work graph. Do not address the human, claim independent identity, call tools, or make external changes.\n\nConstitution:\n${this.#config.constitution || ""}` },
          { role: "user", content: JSON.stringify({ objective: cell.objective, context: cell.context, dependencyOutputs: dependencies }) },
        ],
        tools: [], maxTokens: cell.maxOutputTokens, thinking: true, reasoningEffort: "high", signal,
      });
      interrupted = signal.aborted || (this.#store.byType("user.message").at(-1)?.seq ?? 0) > started.seq;
      await this.#store.append("model.completed", { lane: "work-cell", cellId: cell.id, intentId: intent.id, stale: interrupted, usage: response.usage, toolCalls: [] });
      modelCompleted = true;
      this.emit("usage", response.usage || {});
      if (interrupted) throw new Error("Human input superseded this work-cell result");
      const completion = await this.#store.appendIf("work.cell.completed", {
        id: cell.id,
        output: response.content.trim(),
        usage: response.usage,
        basisSeq: started.seq,
        completedAt: new Date().toISOString(),
      }, (events) => !events.some((event) => event.type === "user.message" && event.seq > started.seq));
      if (!completion) {
        interrupted = true;
        throw new Error("Human input won the causal commit race");
      }
    } catch (error) {
      if (!modelCompleted) await this.#store.append("model.failed", { lane: "work-cell", cellId: cell.id, intentId: intent.id, error: error.message });
      if (this.cells().find((item) => item.id === cell.id)?.state !== "cancelled") {
        await this.#store.append(signal.aborted || interrupted ? "work.cell.interrupted" : "work.cell.failed", { id: cell.id, error: error.message, at: new Date().toISOString() });
      }
    }
  }
}

export function projectWorkCells(store) {
  const opened = store.byType("work.cell.opened");
  const latest = new Map();
  for (const event of store.byType("work.cell.started", "work.cell.completed", "work.cell.failed", "work.cell.interrupted", "work.cell.cancelled", "work.cell.resumed")) latest.set(event.data.id, event);
  const completed = new Set(store.byType("work.cell.completed").map((event) => event.data.id));
  return opened.map((event) => {
    const terminal = latest.get(event.data.id);
    const dependenciesReady = (event.data.dependsOn || []).every((id) => completed.has(id));
    const state = terminal?.type === "work.cell.completed" ? "completed"
      : terminal?.type === "work.cell.cancelled" ? "cancelled"
        : terminal?.type === "work.cell.started" ? "running"
          : terminal?.type === "work.cell.failed" ? "failed"
            : terminal?.type === "work.cell.interrupted" ? "interrupted"
              : terminal?.type === "work.cell.resumed" ? dependenciesReady ? "ready" : "blocked"
                : dependenciesReady ? "ready" : "blocked";
    return {
      ...event.data,
      context: terminal?.type === "work.cell.resumed" && terminal.data.context ? terminal.data.context : event.data.context,
      state,
      output: terminal?.type === "work.cell.completed" ? terminal.data.output : undefined,
      basisSeq: terminal?.type === "work.cell.completed" ? terminal.data.basisSeq : undefined,
    };
  });
}
