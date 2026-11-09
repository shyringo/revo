import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { renderPiFrame, Tui } from "../src/tui/tui.js";

const status = {
  awake: true, phase: "thinking", cycle: 12, elapsedMs: 83_000,
  tokenBudget: 200_000, usage: { totalTokens: 12_345, calls: 18 },
};

test("TUI produces a stable narrow-terminal frame without leaking terminal escapes", () => {
  const frame = renderPiFrame({
    width: 60, height: 20, status,
    selfState: { attention: "inspect \x1b[2J untrusted output" },
    intentions: [], approvals: [], input: "hello", notice: "",
    events: [{ at: new Date().toISOString(), type: "assistant.message", data: { text: "Still learning the environment.", lane: "interaction" } }],
  });
  const lines = frame.split("\n");
  assert.equal(lines.length, 20);
  assert.doesNotMatch(frame, /\x1b\[2J/);
  assert.match(frame, /Still learning/);
  assert.match(frame, /hello/);
});

test("CHAT and LIFE are separate projections of one event stream", () => {
  const events = [
    { at: new Date().toISOString(), type: "user.message", data: { text: "human question" } },
    { at: new Date().toISOString(), type: "assistant.message", data: { text: "direct answer", lane: "interaction" } },
    { at: new Date().toISOString(), type: "assistant.message", data: { text: "autonomous observation", proactive: true } },
  ];
  const base = { width: 80, height: 24, status, selfState: { attention: "testing" }, intentions: [], approvals: [], input: "", notice: "", events };
  const chat = renderPiFrame({ ...base, view: "chat" });
  const life = renderPiFrame({ ...base, view: "life" });
  assert.match(chat, /human question/);
  assert.match(chat, /direct answer/);
  assert.doesNotMatch(chat, /autonomous observation/);
  assert.match(life, /autonomous observation/);
  assert.doesNotMatch(life, /direct answer/);
});

test("deliveries stay in a dedicated durable view with pending badge", () => {
  const events = [{
    at: new Date().toISOString(), type: "delivery.created",
    data: { id: "delivery-12345678", title: "Research report", summary: "Completed", content: "Full durable result" },
  }];
  const frame = renderPiFrame({ width: 90, height: 22, status, selfState: { attention: "done" }, intentions: [], approvals: [], input: "", notice: "", events, view: "deliveries" });
  assert.match(frame, /DELIVERIES 1/);
  assert.match(frame, /Research report/);
  assert.match(frame, /Full durable result/);
});

test("proactive speech enters CHAT with an unresponded badge but not direct-reply semantics", () => {
  const events = [{
    id: "outreach", seq: 4, at: new Date().toISOString(), type: "proactive.message",
    data: { id: "outreach", kind: "discovery", text: "I found a structural contradiction." }, meta: {},
  }];
  const frame = renderPiFrame({ width: 90, height: 20, status, selfState: { attention: "sharing" }, events, view: "chat" });
  assert.match(frame, /1 CHAT 1/);
  assert.match(frame, /SPOKE FIRST/);
  assert.match(frame, /structural contradiction/);
});

test("tool evidence stays compact until explicitly expanded", () => {
  const events = [{
    id: "tool", seq: 3, at: new Date().toISOString(), type: "tool.completed",
    data: { name: "read", arguments: { path: "notes.txt" }, result: { ok: true, value: "private evidence line" } }, meta: {},
  }];
  const base = { width: 90, height: 20, status, selfState: { attention: "checking evidence" }, events, view: "life" };
  assert.doesNotMatch(renderPiFrame(base), /private evidence line/);
  assert.match(renderPiFrame({ ...base, expandedTools: true }), /private evidence line/);
});

test("CHAT exposes interaction progress and retryable failures", () => {
  const base = { width: 80, height: 20, status: { ...status, phase: "responding" }, selfState: { attention: "human" }, intentions: [], approvals: [], input: "", notice: "", view: "chat" };
  assert.match(renderPiFrame({ ...base, events: [] }), /responding/);
  const failed = renderPiFrame({ ...base, status: { ...status, phase: "impaired" }, events: [{ at: new Date().toISOString(), type: "cycle.failed", data: { phase: "responding", error: "timeout" } }] });
  assert.match(failed, /reply interrupted/);
  assert.match(failed, /timeout\. Retrying/);
});

test("TUI makes pending approval the primary action", () => {
  const frame = renderPiFrame({
    width: 100, height: 24, status,
    selfState: { attention: "editing" }, intentions: [], events: [], input: "", notice: "",
    approvals: [{ id: "a", reason: "Replace an existing file" }],
  });
  assert.match(frame, /CONFIRM/);
  assert.match(frame, /Alt\+Y approve/);
});

test("minimum-width TUI does not wrap its structural lines", () => {
  const frame = renderPiFrame({
    width: 40, height: 16, status,
    selfState: { attention: "a very long attention label that must be truncated" },
    intentions: [], events: [], approvals: [], input: "", notice: "", view: "chat",
  });
  const plain = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(plain.split("\n").every((line) => line.length <= 40));
});

test("closing the TUI releases stdin and every live subscription", () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (value) => rawModes.push(value);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const runtime = new EventEmitter();
  runtime.status = () => status;
  runtime.selfState = () => ({ attention: "test" });
  runtime.intentions = () => [];
  let unsubscribed = false;
  const store = { all: () => [], subscribe: () => () => { unsubscribed = true; } };
  const tui = new Tui({ runtime, store, approvals: { list: () => [] }, input, output });
  tui.start();
  tui.close();
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(runtime.listenerCount("status"), 0);
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(unsubscribed, true);
});

test("closing a TUI that never finished starting does not mask the real failure", () => {
  const runtime = new EventEmitter();
  const store = { all: () => [], subscribe: () => () => {} };
  const tui = new Tui({ runtime, store, approvals: { list: () => [] } });
  assert.doesNotThrow(() => tui.close());
  assert.doesNotThrow(() => tui.close());
});
