import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Tui } from "../src/tui/tui.js";

const status = {
  awake: true, phase: "thinking", cycle: 3, elapsedMs: 4_000, workspace: process.cwd(),
  durationLimitMs: Infinity, tokenBudget: 10_000, usage: { totalTokens: 123, calls: 2 },
};

test("pi Editor submits Chinese wide text and multiline input intact", async () => {
  const harness = createHarness();
  harness.tui.start();
  harness.terminal.input("你好，Revo");
  harness.terminal.input("\r");
  await waitFor(() => harness.received.length === 1);
  assert.equal(harness.received[0], "你好，Revo");
  harness.terminal.input("第一行");
  harness.terminal.input("\x1b[13;2u");
  harness.terminal.input("第二行");
  harness.terminal.input("\r");
  await waitFor(() => harness.received.length === 2);
  assert.equal(harness.received[1], "第一行\n第二行");
  harness.tui.close();
});

test("pi Editor preserves prompt history and Ctrl+T switches the life projection", async () => {
  const harness = createHarness();
  harness.tui.start();
  harness.terminal.input("remember this prompt");
  harness.terminal.input("\r");
  await waitFor(() => harness.received.length === 1);
  harness.terminal.input("\x1b[A");
  harness.terminal.input("\r");
  await waitFor(() => harness.received.length === 2);
  assert.equal(harness.received[1], "remember this prompt");
  harness.terminal.input("\x14");
  await waitFor(() => harness.terminal.output.includes("LIFE"));
  harness.tui.close();
});

test("pi ScrollView mouse wheel reaches conversation older than the viewport", async () => {
  const events = Array.from({ length: 80 }, (_, index) => ({
    id: `message-${index}`, seq: index + 1, at: new Date().toISOString(),
    type: "user.message", data: { text: `conversation-${String(index).padStart(2, "0")}` }, meta: {},
  }));
  const harness = createHarness(events);
  try {
    harness.tui.start();
    await waitFor(() => harness.terminal.output.includes("conversation-79"));
    assert.doesNotMatch(harness.terminal.output, /conversation-00/);
    for (let index = 0; index < 100; index++) harness.terminal.input("\x1b[<64;10;10M");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const visible = [...harness.terminal.output.matchAll(/conversation-(\d{2})/g)].map((match) => match[1]);
    assert.ok(visible.includes("00"), `oldest visible indices after scroll: ${visible.slice(-20).join(",")}`);
  } finally {
    harness.tui.close();
  }
});

test("proactive speech flashes without stealing the current LIFE view", async () => {
  const harness = createHarness();
  harness.tui.start();
  harness.terminal.input("\x14");
  await harness.store.append("proactive.message", {
    id: "outreach", kind: "discovery", text: "A worthwhile discovery is ready for you.", whyNow: "Material new evidence",
  });
  await waitFor(() => harness.terminal.output.includes("Revo spoke:"));
  assert.match(harness.terminal.output, /2 LIFE/);
  harness.tui.close();
});

test("closing the pi-backed TUI stops its terminal and subscriptions", () => {
  const harness = createHarness();
  harness.tui.start();
  harness.tui.close();
  assert.equal(harness.terminal.stopped, true);
  assert.equal(harness.runtime.listenerCount("status"), 0);
  assert.equal(harness.store.unsubscribed, true);
});

function createHarness(events = []) {
  const terminal = new FakeTerminal();
  const runtime = new EventEmitter();
  const received = [];
  runtime.status = () => status;
  runtime.selfState = () => ({ attention: "understand the workspace" });
  runtime.intentions = () => [];
  runtime.receive = async (text) => { received.push(text); };
  runtime.requestSleep = () => true;
  const store = {
    events: [...events], unsubscribed: false,
    all() { return this.events; },
    subscribe(listener) { this.listener = listener; return () => { this.unsubscribed = true; }; },
    async append(type, data) { const value = { id: crypto.randomUUID(), seq: this.events.length + 1, at: new Date().toISOString(), type, data, meta: {} }; this.events.push(value); this.listener?.(value); return value; },
  };
  const tui = new Tui({ runtime, store, approvals: { list: () => [], decide: async () => false }, terminal });
  return { tui, terminal, runtime, store, received };
}

class FakeTerminal {
  columns = 72;
  rows = 24;
  kittyProtocolActive = false;
  writes = [];
  stopped = false;
  start(onInput) { this.onInput = onInput; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(value) { this.writes.push(value); }
  input(value) { this.onInput(value); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  get output() { return this.writes.join(""); }
}

async function waitFor(predicate) {
  const end = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
