import { projectWorkCells } from "./workgraph.js";

export function projectOfflineStatus(store) {
  const identity = store.byType("identity.born").at(0)?.data || null;
  const lifecycle = store.byType("life.awoke", "life.slept", "life.forced_sleep");
  const lastLifecycle = lifecycle.at(-1) || null;
  const resolvedHumans = new Set(store.byType("human.input.resolved").map((event) => event.data.messageSeq));
  const obligations = store.byType("user.message").filter((event) => !resolvedHumans.has(event.seq));
  const acknowledged = new Set(store.byType("delivery.acknowledged").map((event) => event.data.id));
  const deliveries = store.byType("delivery.created").filter((event) => !acknowledged.has(event.data.id));
  const lastHumanSeq = store.byType("user.message").at(-1)?.seq ?? 0;
  const outreach = store.byType("proactive.message").filter((event) => event.seq > lastHumanSeq);
  const settledTools = new Set([
    ...store.byType("tool.completed"), ...store.byType("tool.failed"),
  ].map((event) => event.data.intentId).filter(Boolean));
  for (const event of store.byType("tool.reconciled")) if (event.data.outcome !== "still_unknown") settledTools.add(event.data.intentId);
  const unknownEffects = store.byType("tool.intent").filter((event) => !settledTools.has(event.id));
  const completedSleeps = store.byType("life.slept");
  const workCells = projectWorkCells(store);
  const lifetimeTokens = completedSleeps.reduce((total, event) => total + Number(event.data.usage?.totalTokens || 0), 0);
  return {
    formatVersion: store.byType("life.format").at(-1)?.data.version || null,
    identity,
    state: lastLifecycle?.type === "life.awoke"
      ? "interrupted-or-awake"
      : lastLifecycle?.type === "life.forced_sleep" ? "asleep-forced" : identity ? "asleep" : "unborn",
    lastLifecycle: lastLifecycle ? { type: lastLifecycle.type, at: lastLifecycle.at, reason: lastLifecycle.data.reason } : null,
    attention: store.byType("self.updated").at(-1)?.data || null,
    obligations: obligations.map((event) => ({ seq: event.seq, at: event.at, text: event.data.text })),
    pendingDeliveries: deliveries.map((event) => ({ id: event.data.id, at: event.at, title: event.data.title, summary: event.data.summary })),
    unrespondedOutreach: outreach.map((event) => ({ id: event.data.id, at: event.at, kind: event.data.kind, text: event.data.text })),
    unknownEffects: unknownEffects.map((event) => ({ intentId: event.id, at: event.at, name: event.data.name, arguments: event.data.arguments })),
    workgraph: {
      total: workCells.length,
      active: workCells.filter((cell) => ["ready", "running", "blocked", "interrupted"].includes(cell.state)).length,
      completed: workCells.filter((cell) => cell.state === "completed").length,
      failed: workCells.filter((cell) => cell.state === "failed").length,
    },
    lifetimeTokens,
    events: store.all().length,
  };
}

export function formatOfflineStatus(status) {
  if (!status.identity) return "Revo has not been born in this state directory.";
  const lines = [
    `Revo ${status.identity.id}`,
    `life format: ${status.formatVersion ?? "legacy"}`,
    `state: ${status.state}`,
    `events: ${status.events}`,
    `completed-awakening tokens: ${status.lifetimeTokens.toLocaleString("en-US")}`,
    `human obligations: ${status.obligations.length}`,
    `pending deliveries: ${status.pendingDeliveries.length}`,
    `unresponded proactive messages: ${status.unrespondedOutreach.length}`,
    `unknown external effects: ${status.unknownEffects.length}`,
    `workgraph: ${status.workgraph.active} active / ${status.workgraph.completed} completed / ${status.workgraph.failed} failed`,
  ];
  if (status.lastLifecycle) lines.push(`last lifecycle: ${status.lastLifecycle.type} at ${status.lastLifecycle.at}${status.lastLifecycle.reason ? ` (${status.lastLifecycle.reason})` : ""}`);
  if (status.attention?.attention) lines.push(`last attention: ${status.attention.attention}`);
  for (const delivery of status.pendingDeliveries) lines.push(`DELIVERY ${delivery.id.slice(0, 8)}  ${delivery.title} - ${delivery.summary}`);
  for (const message of status.unrespondedOutreach.slice(-3)) lines.push(`OUTREACH ${message.kind}  ${message.text}`);
  for (const obligation of status.obligations.slice(-5)) lines.push(`HUMAN #${obligation.seq}  ${obligation.text}`);
  return lines.join("\n");
}

export function findDelivery(store, selector = "latest") {
  const deliveries = store.byType("delivery.created");
  if (!deliveries.length) return null;
  if (selector === "latest") return deliveries.at(-1).data;
  const matches = deliveries.filter((event) => event.data.id === selector || event.data.id.startsWith(selector));
  if (matches.length > 1) throw new Error(`Delivery prefix "${selector}" is ambiguous`);
  return matches[0]?.data || null;
}

export function formatDelivery(delivery) {
  if (!delivery) return "Delivery not found.";
  return [`DELIVERY ${delivery.id}`, delivery.title, delivery.summary, "", delivery.content].join("\n");
}
