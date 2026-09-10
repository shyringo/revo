import { performance } from "node:perf_hooks";
import { ViewProjection } from "../src/tui/tui.js";
import { projectOfflineStatus } from "../src/core/offline-status.js";

const now = new Date().toISOString();
const events = Array.from({ length: 10_000 }, (_, index) => index % 2 === 0
  ? { id: `u${index}`, seq: index + 1, at: now, type: "user.message", data: { text: `human message ${index}` }, meta: {} }
  : { id: `a${index}`, seq: index + 1, at: now, type: "assistant.message", data: { text: `direct reply ${index}`, lane: "interaction", proactive: false, replyToSeq: index }, meta: {} });

const firstSamples = [];
const redrawSamples = [];
for (let iteration = 0; iteration < 9; iteration++) {
  const projection = new ViewProjection();
  const firstStart = performance.now();
  projection.render("chat", events, 140);
  firstSamples.push(performance.now() - firstStart);
  const redrawStart = performance.now();
  projection.render("chat", events, 140);
  redrawSamples.push(performance.now() - redrawStart);
}

const byType = new Map();
for (const event of events) {
  const list = byType.get(event.type) || [];
  list.push(event);
  byType.set(event.type, list);
}
const store = {
  all: () => events,
  byType: (...types) => types.flatMap((type) => byType.get(type) || []).sort((a, b) => a.seq - b.seq),
};
const statusSamples = [];
for (let iteration = 0; iteration < 9; iteration++) {
  const statusStart = performance.now();
  projectOfflineStatus(store);
  statusSamples.push(performance.now() - statusStart);
}

console.log(JSON.stringify({
  events: events.length,
  iterations: 9,
  medianFirstProjectionMs: median(firstSamples),
  medianProjectedRedrawMs: median(redrawSamples),
  medianOfflineStatusMs: median(statusSamples),
}, null, 2));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
