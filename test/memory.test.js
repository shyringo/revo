import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { estimateEventTokens, Memory } from "../src/memory/memory.js";

test("memory ranks matching durable facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-memory-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  await memory.remember("The preferred database is SQLite", "preference", 0.7);
  await memory.remember("The interface uses a green status light", "semantic", 0.9);
  assert.match(memory.retrieve("Which database should I use?")[0].text, /SQLite/);
});

test("Chinese bigrams retrieve related memory without embedding cost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-memory-zh-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  await memory.remember("长期目标是全人类的幸福和解放", "semantic", 0.8);
  await memory.remember("界面使用绿色状态灯", "semantic", 0.8);
  assert.match(memory.retrieve("人类幸福目标")[0].text, /幸福和解放/);
});

test("identical memory is reinforced rather than duplicated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-memory-reinforce-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  const first = await memory.remember("Stable fact", "semantic", 0.5);
  const second = await memory.remember("  stable   fact  ", "semantic", 0.7);
  assert.equal(second.id, first.id);
  assert.equal(second.reinforced, true);
  assert.equal(store.byType("memory.remembered").length, 1);
  assert.equal(store.byType("memory.reinforced").length, 1);
});

test("event token estimate counts model-visible durable content conservatively", () => {
  const events = [{ seq: 1, at: new Date().toISOString(), type: "user.message", data: { text: "a".repeat(300) } }];
  assert.ok(estimateEventTokens(events) >= 100);
});

test("compaction keeps an append-only summary checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-compact-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  for (let index = 0; index < 12; index++) await store.append("user.message", { text: `message ${index}` });
  const model = { complete: async () => ({ content: "decisions and unfinished work" }) };
  const result = await memory.compact(model, store.all());
  assert.equal(result.summary, "decisions and unfinished work");
  assert.equal(store.byType("context.compacted").length, 1);
  assert.ok(memory.surfaceEvents().every((event) => event.seq > result.throughSeq));
});

test("failed compaction preserves the original visible surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-compact-fail-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  for (let index = 0; index < 12; index++) await store.append("user.message", { text: `important ${index}` });
  const before = memory.surfaceEvents(Infinity).map((event) => event.id);
  const result = await memory.compact({ complete: async () => { throw new Error("provider unavailable"); } }, memory.surfaceEvents(Infinity));
  assert.equal(result, null);
  assert.equal(store.byType("context.compacted").length, 0);
  assert.deepEqual(memory.surfaceEvents(Infinity).filter((event) => event.type === "user.message").map((event) => event.id), before);
  assert.equal(store.byType("context.compaction_failed").length, 1);
});

test("iterative compaction explicitly carries the previous summary forward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-compact-chain-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const memory = new Memory(store);
  for (let index = 0; index < 12; index++) await store.append("user.message", { text: `first ${index}` });
  let request = "";
  const model = { complete: async ({ messages }) => { request = messages.at(-1).content; return { content: request.includes("summary-one") ? "summary-two" : "summary-one", usage: {} }; } };
  await memory.compact(model, memory.surfaceEvents(Infinity));
  for (let index = 0; index < 12; index++) await store.append("user.message", { text: `second ${index}` });
  await memory.compact(model, memory.surfaceEvents(Infinity));
  assert.match(request, /Previous summary\nsummary-one/);
  assert.equal(memory.latestCompaction().data.summary, "summary-two");
});
