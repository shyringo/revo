import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { acquireLifeLock, lifeLockPort } from "../src/core/life-lock.js";

test("one durable identity cannot be awake in two local processes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "revo-life-lock-"));
  const first = await acquireLifeLock(stateDir);
  await assert.rejects(acquireLifeLock(stateDir), /already awake/);
  await first.release();
  const afterSleep = await acquireLifeLock(stateDir);
  assert.equal(afterSleep.port, first.port);
  await afterSleep.release();
});

test("an unrelated service on the first candidate port does not impersonate Revo", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "revo-life-collision-"));
  const occupiedPort = lifeLockPort(stateDir, 0);
  const unrelated = createServer((socket) => socket.end("not-revo\n"));
  await new Promise((resolve) => unrelated.listen(occupiedPort, "127.0.0.1", resolve));
  const lock = await acquireLifeLock(stateDir);
  assert.notEqual(lock.port, occupiedPort);
  await lock.release();
  await new Promise((resolve) => unrelated.close(resolve));
});
