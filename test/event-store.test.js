import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";

test("event store persists ordered append-only facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-events-"));
  const path = join(directory, "events.jsonl");
  const first = await new EventStore(path).open();
  await Promise.all([first.append("a", { value: 1 }), first.append("b", { value: 2 })]);
  await first.flush();
  const second = await new EventStore(path).open();
  assert.deepEqual(second.all().map((event) => [event.seq, event.type]), [[1, "a"], [2, "b"]]);
});

test("committed events are detached immutable JSON snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-event-snapshot-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const data = { nested: { value: 1 } };
  const event = await store.append("fact", data);
  data.nested.value = 2;
  assert.equal(event.data.nested.value, 1);
  assert.equal(Object.isFrozen(event.data.nested), true);
  await assert.rejects(store.append("bad", { value: 1n }), /serialize|BigInt/);
  const next = await store.append("next", {});
  assert.equal(next.seq, 2, "failed serialization does not consume a sequence");
});

test("checkpoint creates an immutable verifiable life snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-checkpoint-"));
  const path = join(directory, "life.jsonl");
  const store = await new EventStore(path).open();
  await store.append("life.slept", { reason: "test" });
  const checkpoint = await store.checkpoint(join(directory, "snapshots"));
  assert.equal(checkpoint.throughSeq, 1);
  assert.match(await readFile(`${checkpoint.path}.sha256`, "utf8"), new RegExp(`^${checkpoint.sha256}`));
  await assert.rejects(store.checkpoint(join(directory, "snapshots")), /exist/i, "same event cannot overwrite its snapshot");
});

test("post-commit observers see durable facts and cannot break appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-event-observer-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const observed = [];
  store.subscribe((event) => observed.push(event.seq));
  store.subscribe(() => { throw new Error("observer failure"); });
  const event = await store.append("fact", {});
  assert.equal(event.seq, 1);
  assert.deepEqual(observed, [1]);
  assert.equal(store.all().length, 1);
});

test("conditional append is serialized atomically with competing durable events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-conditional-"));
  const store = await new EventStore(join(directory, "events.jsonl")).open();
  const competing = store.append("user.message", { text: "human wins" });
  const completion = store.appendIf("work.cell.completed", { id: "cell" }, (events) => !events.some((event) => event.type === "user.message"));
  await competing;
  assert.equal(await completion, null);
  assert.equal(store.byType("work.cell.completed").length, 0);
  const accepted = await store.appendIf("audit.accepted", { ok: true }, (events) => events.at(-1)?.type === "user.message");
  assert.equal(accepted.type, "audit.accepted");
});

test("a torn final write is preserved and life continues in a new segment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-torn-tail-"));
  const path = join(directory, "life.jsonl");
  const first = await new EventStore(path).open();
  await first.append("first", { value: 1 });
  await appendFile(path, '{"id":"torn"');
  const recovered = await new EventStore(path).open();
  assert.equal(recovered.all().length, 1);
  await recovered.append("second", { value: 2 });
  const reopened = await new EventStore(path).open();
  assert.deepEqual(reopened.all().map((event) => [event.seq, event.type]), [[1, "first"], [2, "second"]]);
  const segments = (await readdir(directory)).filter((name) => name.includes(".segment-"));
  assert.equal(segments.length, 1);
  assert.match(await readFile(path, "utf8"), /\{"id":"torn"$/);
});

test("a complete event missing only its newline is sealed before the next append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-missing-newline-"));
  const path = join(directory, "life.jsonl");
  await writeFile(path, JSON.stringify({ id: "one", seq: 1, at: new Date().toISOString(), type: "first", data: {}, meta: {} }));
  const store = await new EventStore(path).open();
  await store.append("second", {});
  const reopened = await new EventStore(path).open();
  assert.deepEqual(reopened.all().map((event) => event.type), ["first", "second"]);
  assert.equal((await readdir(directory)).filter((name) => name.includes(".segment-")).length, 1);
});
