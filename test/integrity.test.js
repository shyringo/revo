import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { verifyStateIntegrity } from "../src/core/integrity.js";

test("integrity check replays life and verifies the latest snapshot", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "revo-integrity-"));
  const store = await new EventStore(join(stateDir, "life.jsonl")).open();
  await store.append("identity.born", { id: "one" });
  await store.append("life.slept", {});
  await store.checkpoint(join(stateDir, "snapshots"));
  const result = await verifyStateIntegrity(stateDir);
  assert.equal(result.events, 2);
  assert.equal(result.identityId, "one");
  assert.equal(result.snapshot.events, 2);
});

test("integrity check rejects a corrupt event envelope", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "revo-integrity-bad-"));
  const path = join(stateDir, "life.jsonl");
  await appendFile(path, '{"id":"x","seq":2,"at":"now","type":"bad","data":{}}\n');
  await assert.rejects(verifyStateIntegrity(stateDir), /Invalid event envelope/);
});
