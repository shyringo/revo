import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { WorkGraph } from "../src/core/workgraph.js";

test("work cells run as parallel processes of one shared life, not sequential sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-parallel-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  let active = 0;
  let peak = 0;
  const model = { complete: async ({ messages }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return { content: `result:${messages[1].content}`, usage: { total_tokens: 2 }, toolCalls: [], rawMessage: { role: "assistant", content: "result" } };
  } };
  const config = { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 3 } };
  const graph = new WorkGraph({ store, model, config });
  await graph.start();
  await Promise.all(["A", "B", "C"].map((objective) => graph.open({ objective })));
  await waitFor(() => graph.cells().every((cell) => cell.state === "completed"));
  assert.equal(peak, 3);
  assert.equal(store.byType("work.cell.opened").length, 3);
  assert.equal(store.byType("work.cell.completed").length, 3);
  await graph.close();
});

test("human interruption preempts every running cell and prevents stale adoption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-interrupt-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  const model = { complete: ({ signal }) => new Promise((resolve) => {
    const finish = () => resolve({ content: "stale result", usage: { total_tokens: 3 }, toolCalls: [], rawMessage: { role: "assistant", content: "stale result" } });
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 2 } } });
  await graph.start();
  await graph.open({ objective: "A" });
  await graph.open({ objective: "B" });
  await waitFor(() => store.byType("work.cell.started").length === 2);
  await graph.interrupt("human spoke");
  await waitFor(() => store.byType("work.cell.interrupted").length === 2);
  assert.equal(store.byType("work.cell.completed").length, 0);
  assert.ok(store.byType("model.completed").every((event) => event.data.stale === true));
  graph.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.byType("work.cell.started").length, 2, "human-interrupted cells never auto-resume");
  await graph.close();
});

test("an interrupted cell resumes only through an explicit plan decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-resume-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  let calls = 0;
  const model = { complete: ({ messages, signal }) => {
    calls += 1;
    if (calls > 1) return Promise.resolve({ content: messages[1].content, usage: {}, toolCalls: [], rawMessage: { role: "assistant", content: "done" } });
    return new Promise((resolve) => {
      const finish = () => resolve({ content: "stale", usage: {}, toolCalls: [], rawMessage: { role: "assistant", content: "stale" } });
      if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
    });
  } };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1 } } });
  await graph.start();
  const cell = await graph.open({ objective: "old objective", context: "old" });
  await waitFor(() => store.byType("work.cell.started").length === 1);
  await graph.interrupt("human spoke");
  await waitFor(() => graph.cells()[0].state === "interrupted");
  graph.resume();
  await graph.resumeCell(cell.id, "new human context");
  await waitFor(() => graph.cells()[0].state === "completed");
  await graph.close();
  assert.match(store.byType("work.cell.completed")[0].data.output, /new human context/);
});

test("dependent work cells start only after their prerequisites complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-deps-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  const releases = [];
  const model = { complete: () => new Promise((resolve) => releases.push(() => resolve({ content: "done", usage: {}, toolCalls: [], rawMessage: { role: "assistant", content: "done" } }))) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 2 } } });
  await graph.start();
  const first = await graph.open({ objective: "source" });
  const second = await graph.open({ objective: "dependent", dependsOn: [first.id] });
  await waitFor(() => store.byType("work.cell.started").length === 1 && releases.length === 1);
  assert.equal(graph.cells().find((cell) => cell.id === second.id).state, "blocked");
  releases.shift()();
  await waitFor(() => store.byType("work.cell.started").length === 2 && releases.length === 1);
  releases.shift()();
  await waitFor(() => graph.cells().find((cell) => cell.id === second.id).state === "completed");
  await graph.close();
});

test("restart recovers an orphaned running cell instead of leaving phantom work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-recover-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  await store.append("work.cell.opened", { id: "orphan", objective: "recover", context: "", dependsOn: [], maxOutputTokens: 256 });
  await store.append("work.cell.started", { id: "orphan" });
  const model = { complete: async () => ({ content: "recovered result", usage: {}, toolCalls: [], rawMessage: { role: "assistant", content: "recovered result" } }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1 } } });
  await graph.start();
  await waitFor(() => graph.cells()[0].state === "completed");
  assert.equal(store.byType("work.cell.interrupted")[0].data.recovered, true);
  assert.equal(store.byType("work.cell.resumed")[0].data.recovered, true);
  assert.equal(store.byType("work.cell.completed")[0].data.id, "orphan");
  await graph.close();
});

test("a durably committed human message rejects a racing cell result before abort delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-human-race-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  let release;
  const model = { complete: () => new Promise((resolve) => { release = () => resolve({ content: "too late", usage: { total_tokens: 2 }, toolCalls: [], rawMessage: { role: "assistant", content: "too late" } }); }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1 } } });
  await graph.start();
  await graph.open({ objective: "racing work" });
  await waitFor(() => typeof release === "function");
  await store.append("user.message", { text: "change direction" });
  release();
  await waitFor(() => store.byType("work.cell.interrupted").length === 1);
  assert.equal(store.byType("work.cell.completed").length, 0);
  assert.equal(store.byType("model.completed")[0].data.stale, true);
  await graph.close();
});

test("atomic completion loses when human input queues during model settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-atomic-race-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  let injected = false;
  store.subscribe((event) => {
    if (!injected && event.type === "model.completed" && event.data.lane === "work-cell") {
      injected = true;
      void store.append("user.message", { text: "human enters at settlement" });
    }
  });
  const model = { complete: async () => ({ content: "racing result", usage: {}, toolCalls: [], rawMessage: { role: "assistant", content: "racing result" } }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1 } } });
  await graph.start();
  await graph.open({ objective: "race" });
  await waitFor(() => store.byType("work.cell.interrupted").length === 1);
  assert.equal(store.byType("work.cell.completed").length, 0);
  await graph.close();
});

test("cancelling running work remains terminal after its abort settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-cancel-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  const model = { complete: ({ signal }) => new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
  }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1 } } });
  await graph.start();
  const cell = await graph.open({ objective: "obsolete work" });
  await waitFor(() => store.byType("work.cell.started").length === 1);
  await graph.cancel(cell.id, "superseded");
  await waitFor(() => graph.cells()[0].state === "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(graph.cells()[0].state, "cancelled");
  assert.equal(store.byType("work.cell.interrupted").length, 0);
  await graph.close();
});

test("a later unrelated human message does not retroactively invalidate committed evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-version-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  await store.append("work.cell.opened", { id: "source", objective: "source", dependsOn: [] });
  await store.append("work.cell.completed", { id: "source", output: "old", basisSeq: 1, committedThroughSeq: 1 });
  await store.append("work.cell.opened", { id: "dependent", objective: "dependent", dependsOn: ["source"] });
  await store.append("user.message", { text: "the premise changed" });
  const graph = new WorkGraph({ store, model: {}, config: { workgraph: { maxConcurrency: 1 } } });
  assert.equal(graph.cells().find((cell) => cell.id === "source").state, "completed");
  assert.equal(graph.cells().find((cell) => cell.id === "dependent").state, "ready");
});

test("admission bounds all unfinished work rather than only running calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-workgraph-capacity-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  const model = { complete: ({ signal }) => new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
  }) };
  const graph = new WorkGraph({ store, model, config: { constitution: "one life", model: { name: "mock" }, workgraph: { maxConcurrency: 1, maxOutstanding: 2 } } });
  await graph.start();
  assert.equal((await graph.open({ objective: "one" })).admitted, true);
  assert.equal((await graph.open({ objective: "two" })).admitted, true);
  const refused = await graph.open({ objective: "three" });
  assert.equal(refused.admitted, false);
  assert.equal(refused.outstanding, 2);
  assert.equal(store.byType("work.cell.opened").length, 2);
  await graph.cancel(graph.cells()[0].id, "free capacity");
  assert.equal((await graph.open({ objective: "three" })).admitted, true);
  await graph.close();
});

async function waitFor(predicate) {
  const end = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
