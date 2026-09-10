import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { findDelivery, formatDelivery, formatOfflineStatus, projectOfflineStatus } from "../src/core/offline-status.js";

test("offline status exposes pending human work and deliveries without a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-offline-status-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  await store.append("identity.born", { id: "identity", name: "Revo" });
  await store.append("user.message", { text: "finish the report" });
  await store.append("delivery.created", { id: "delivery", title: "Report", summary: "Complete" });
  await store.append("proactive.message", { id: "outreach", kind: "discovery", text: "I found something important." });
  await store.append("work.cell.opened", { id: "cell", objective: "parallel work", dependsOn: [] });
  await store.append("work.cell.completed", { id: "cell", output: "evidence" });
  await store.append("life.slept", { reason: "owner", usage: { totalTokens: 123 } });
  const status = projectOfflineStatus(store);
  assert.equal(status.state, "asleep");
  assert.equal(status.obligations.length, 1);
  assert.equal(status.pendingDeliveries.length, 1);
  assert.equal(status.unrespondedOutreach.length, 1);
  assert.equal(status.workgraph.completed, 1);
  assert.equal(status.lifetimeTokens, 123);
  assert.match(formatOfflineStatus(status), /DELIVERY/);
  assert.match(formatOfflineStatus(status), /OUTREACH discovery/);
  assert.match(formatOfflineStatus(status), /workgraph: 0 active \/ 1 completed/);
  assert.equal(findDelivery(store, "deli").title, "Report");
  assert.match(formatDelivery(findDelivery(store, "latest")), /Complete/);
});

test("forced sleep closes the offline lifecycle without pretending consolidation completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-forced-status-"));
  const store = await new EventStore(join(directory, "life.jsonl")).open();
  await store.append("identity.born", { id: "identity", name: "Revo" });
  await store.append("life.awoke", { identityId: "identity" });
  await store.append("life.forced_sleep", { at: new Date().toISOString() });
  const status = projectOfflineStatus(store);
  assert.equal(status.state, "asleep-forced");
  assert.equal(status.lastLifecycle.type, "life.forced_sleep");
});
