import { randomUUID } from "node:crypto";

export class ApprovalQueue {
  #store;
  #pending = new Map();
  #publish;

  constructor(store, publish = () => {}) {
    this.#store = store;
    this.#publish = publish;
  }

  async request({ tool, arguments: args, reason, signal }) {
    const id = randomUUID();
    const record = { id, tool, arguments: args, reason, requestedAt: new Date().toISOString() };
    await this.#store.append("approval.requested", record);
    this.#publish("approval.requested", record);
    return new Promise((resolve) => {
      const interrupt = () => {
        if (!this.#pending.delete(id)) return;
        void this.#store.append("approval.expired", {
          id,
          reason: "Interrupted by newer input",
          expiredAt: new Date().toISOString(),
        }).finally(() => resolve({ id, approved: false, note: "Interrupted by newer input" }));
      };
      signal?.addEventListener("abort", interrupt, { once: true });
      this.#pending.set(id, {
        record,
        resolve: (decision) => {
          signal?.removeEventListener("abort", interrupt);
          resolve(decision);
        },
      });
    });
  }

  async decide(id, approved, note = "") {
    const item = this.#pending.get(id);
    if (!item) return false;
    this.#pending.delete(id);
    const decision = { id, approved: Boolean(approved), note, decidedAt: new Date().toISOString() };
    await this.#store.append("approval.decided", decision);
    this.#publish("approval.decided", decision);
    item.resolve(decision);
    return true;
  }

  list() {
    return [...this.#pending.values()].map(({ record }) => record);
  }

  async recover() {
    const settled = new Set([
      ...this.#store.byType("approval.decided"),
      ...this.#store.byType("approval.expired"),
    ].map((event) => event.data.id));
    for (const event of this.#store.byType("approval.requested")) {
      if (settled.has(event.data.id)) continue;
      await this.#store.append("approval.expired", {
        id: event.data.id,
        reason: "Process restarted before a decision; approval cannot survive sleep or crash",
        expiredAt: new Date().toISOString(),
      });
    }
  }

  async close() {
    for (const { resolve, record } of this.#pending.values()) {
      await this.#store.append("approval.expired", {
        id: record.id,
        reason: "Runtime stopped",
        expiredAt: new Date().toISOString(),
      });
      resolve({ id: record.id, approved: false, note: "Runtime stopped" });
    }
    this.#pending.clear();
  }
}
