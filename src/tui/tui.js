import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const ESC = "\x1b[";
const COLORS = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  green: `${ESC}38;2;92;210;146m`, cyan: `${ESC}38;2;88;196;221m`,
  yellow: `${ESC}38;2;238;184;82m`, red: `${ESC}38;2;239;107;104m`,
  white: `${ESC}38;2;226;232;240m`, muted: `${ESC}38;2;137;148;164m`,
  faint: `${ESC}38;2;83;94;110m`, violet: `${ESC}38;2;181;145;255m`,
};
const VIEWS = ["chat", "life", "deliveries"];
const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const UI_EVENT_TYPES = new Set([
  "user.message", "assistant.message", "proactive.message", "delivery.created", "delivery.acknowledged",
  "environment.changed", "tool.completed", "tool.failed", "tool.reconciled",
  "memory.remembered", "self.updated", "cycle.failed",
  "work.cell.completed", "work.cell.failed", "work.cell.interrupted",
]);

export class Tui {
  #runtime;
  #store;
  #approvals;
  #terminal;
  #ui;
  #editor;
  #transcript;
  #header;
  #footer;
  #removeInputListener;
  #notice = "";
  #sleepRequested = false;
  #timer = null;
  #closed = false;
  #onEvent;
  #onStatus;
  #forceExit;
  #events;
  #unsubscribeStore;
  #view = "chat";
  #scrollView;
  #toolOutputExpanded = false;

  constructor({ runtime, store, approvals, terminal, input, output, forceExit = () => process.exit(130) }) {
    this.#runtime = runtime;
    this.#store = store;
    this.#approvals = approvals;
    this.#terminal = terminal || (input && output ? new StreamTerminal(input, output) : undefined);
    this.#forceExit = forceExit;
    this.#events = store.all().filter((event) => UI_EVENT_TYPES.has(event.type));
  }

  start() {
    if (!this.#terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error("Revo needs an interactive terminal for its TUI");
    }
    this.#ui = new TuiAltScreen(this.#terminal || new ProcessTerminal(), true, undefined, {
      mouse: true,
      wheelScrollLines: 3,
      searchMatchStyle: (text) => `${ESC}48;2;92;73;34m${COLORS.white}${text}${COLORS.reset}`,
      searchCurrentMatchStyle: (text) => `${ESC}48;2;126;91;26m${COLORS.bold}${COLORS.white}${text}${COLORS.reset}`,
    });
    this.#header = new HeaderComponent(() => this.#view, () => this.#snapshot());
    this.#transcript = new TranscriptComponent(
      () => this.#view, () => this.#events, () => this.#runtime.status(), () => this.#toolOutputExpanded,
    );
    this.#scrollView = new ScrollView(this.#transcript, {
      follow: "end", primary: true, scrollbar: "auto", scrollbarStyle: (text) => `${COLORS.faint}${text}${COLORS.reset}`,
    });
    this.#editor = new Editor(this.#ui, editorTheme(), { paddingX: 1, autocompleteMaxVisible: 7 });
    this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, this.#runtime.status().workspace || process.cwd()));
    this.#editor.onSubmit = (text) => {
      void this.#submit(text).catch((error) => {
        this.#notice = `Input failed: ${error.message}`;
        this.renderSoon();
      });
    };
    this.#footer = new FooterComponent(() => this.#snapshot());
    this.#ui.setLayoutRoot(new VStack([
      { component: this.#header, basis: "auto", shrink: 0 },
      { component: this.#scrollView, basis: 0, grow: 1, minSize: 3 },
      { component: this.#footer, basis: "auto", shrink: 0 },
      { component: this.#editor, basis: "auto", shrink: 1, minSize: 3 },
    ]));
    this.#ui.setFocus(this.#editor);
    this.#removeInputListener = this.#ui.addInputListener((data) => this.#globalInput(data));
    this.#onEvent = (event) => {
      if (UI_EVENT_TYPES.has(event.type)) this.#events.push(event);
      this.#transcript.invalidate();
      if (event.type === "proactive.message" && this.#view !== "chat") {
        this.#ui.flash(`Revo spoke: ${truncateToWidth(clean(event.data.text), 64)}`, 5_000);
      }
      this.renderSoon();
    };
    this.#onStatus = () => this.renderSoon();
    this.#unsubscribeStore = this.#store.subscribe(this.#onEvent);
    this.#runtime.on("status", this.#onStatus);
    this.#timer = setInterval(() => this.renderSoon(), 500);
    this.#ui.start();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#removeInputListener?.();
    this.#unsubscribeStore?.();
    this.#runtime.off("status", this.#onStatus);
    this.#ui?.stop();
  }

  renderSoon() {
    if (this.#closed) return;
    this.#header?.invalidate();
    this.#footer?.invalidate();
    this.#ui?.requestRender();
  }

  #snapshot() {
    return {
      view: this.#view,
      status: this.#runtime.status(),
      selfState: this.#runtime.selfState(),
      intentions: this.#runtime.intentions(),
      approvals: this.#approvals.list(),
      notice: this.#notice,
      pendingDeliveries: pendingDeliveries(this.#store.all()).length,
      unrespondedOutreach: unrespondedOutreach(this.#store.all()).length,
    };
  }

  #globalInput(data) {
    if (matchesKey(data, "ctrl+c")) {
      if (this.#sleepRequested) return this.#forceExit();
      this.#sleepRequested = true;
      this.#notice = "Falling asleep... Press Ctrl+C again to force exit.";
      this.#runtime.requestSleep("owner pressed Ctrl+C");
      this.#editor.disableSubmit = true;
      this.renderSoon();
      return { consume: true };
    }
    if (matchesKey(data, "alt+1")) return this.#switchView("chat");
    if (matchesKey(data, "alt+2")) return this.#switchView("life");
    if (matchesKey(data, "alt+3")) return this.#switchView("deliveries");
    if (matchesKey(data, "ctrl+t")) {
      return this.#switchView(VIEWS[(VIEWS.indexOf(this.#view) + 1) % VIEWS.length]);
    }
    if (matchesKey(data, "ctrl+o")) {
      this.#toolOutputExpanded = !this.#toolOutputExpanded;
      this.#notice = `Tool evidence ${this.#toolOutputExpanded ? "expanded" : "collapsed"}.`;
      this.#transcript.invalidate();
      this.renderSoon();
      return { consume: true };
    }
    const approval = this.#approvals.list()[0];
    if (approval && matchesKey(data, "alt+y")) {
      void this.#decideApproval(approval.id, true);
      return { consume: true };
    }
    if (approval && matchesKey(data, "alt+n")) {
      void this.#decideApproval(approval.id, false);
      return { consume: true };
    }
    return undefined;
  }

  #switchView(view) {
    this.#view = view;
    this.#notice = `${view.toUpperCase()} view`;
    this.#transcript.invalidate();
    this.#scrollView.scrollToEnd();
    this.renderSoon();
    return { consume: true };
  }

  async #submit(value) {
    const text = value.trim();
    if (!text) return this.renderSoon();
    this.#editor.addToHistory(text);
    const command = text.startsWith("/") ? `:${text.slice(1)}` : text;
    if (command === ":sleep") {
      this.#sleepRequested = true;
      this.#notice = "Falling asleep...";
      this.#editor.disableSubmit = true;
      this.#runtime.requestSleep("owner entered :sleep");
    } else if (command === ":help") {
      this.#notice = "Alt+1/2/3 views · Tab complete · Shift+Enter newline · Ctrl+Shift+F search · /sleep";
    } else if ([":chat", ":life", ":deliveries"].includes(command)) {
      this.#view = command.slice(1);
      this.#transcript.invalidate();
      this.#scrollView.scrollToEnd();
      this.#notice = `${this.#view.toUpperCase()} view`;
    } else if (command.startsWith(":ack")) {
      const id = command.split(/\s+/)[1] || pendingDeliveries(this.#store.all()).at(-1)?.data.id;
      if (id) {
        await this.#store.append("delivery.acknowledged", { id, acknowledgedAt: new Date().toISOString() });
        this.#notice = `Delivery ${id.slice(0, 8)} acknowledged.`;
      } else this.#notice = "No pending delivery.";
    } else if (command.startsWith(":approve") || command.startsWith(":deny")) {
      const approved = command.startsWith(":approve");
      const id = command.split(/\s+/)[1] || this.#approvals.list()[0]?.id;
      if (id) await this.#decideApproval(id, approved);
      else this.#notice = "No pending approval.";
    } else if (command.startsWith(":")) {
      this.#notice = `Unknown command: ${command}. Try /help`;
    } else {
      this.#notice = "";
      await this.#runtime.receive(text);
    }
    this.renderSoon();
  }

  async #decideApproval(id, approved) {
    this.#notice = await this.#approvals.decide(id, approved, `${approved ? "Approved" : "Denied"} in TUI`)
      ? `Action ${approved ? "approved" : "denied"}.` : "No matching approval.";
    this.renderSoon();
  }
}

class StreamTerminal {
  #input;
  #output;
  #onData;
  #onResize;
  constructor(input, output) { this.#input = input; this.#output = output; }
  get columns() { return this.#output.columns || 80; }
  get rows() { return this.#output.rows || 24; }
  get kittyProtocolActive() { return false; }
  start(onInput, onResize) {
    this.#input.setRawMode?.(true);
    this.#input.setEncoding?.("utf8");
    this.#input.resume?.();
    this.#onData = (data) => onInput(String(data));
    this.#onResize = onResize;
    this.#input.on("data", this.#onData);
    this.#output.on("resize", this.#onResize);
  }
  stop() {
    this.#input.off("data", this.#onData);
    this.#output.off("resize", this.#onResize);
    this.#input.setRawMode?.(false);
    this.#input.pause?.();
  }
  async drainInput() {}
  write(value) { this.#output.write(value); }
  moveBy(lines) { if (lines) this.write(`${ESC}${Math.abs(lines)}${lines < 0 ? "A" : "B"}`); }
  hideCursor() { this.write(`${ESC}?25l`); }
  showCursor() { this.write(`${ESC}?25h`); }
  clearLine() { this.write(`${ESC}2K`); }
  clearFromCursor() { this.write(`${ESC}0J`); }
  clearScreen() { this.write(`${ESC}2J${ESC}H`); }
  setTitle(title) { this.write(`\x1b]0;${clean(title)}\x07`); }
  setProgress() {}
}

const COMMANDS = [
  { name: "chat", description: "Open direct conversation" },
  { name: "life", description: "Open autonomous life activity" },
  { name: "deliveries", description: "Open durable completed work" },
  { name: "ack", description: "Acknowledge the latest delivery", argumentHint: "[delivery-id]" },
  { name: "approve", description: "Approve the pending irreversible action", argumentHint: "[approval-id]" },
  { name: "deny", description: "Deny the pending irreversible action", argumentHint: "[approval-id]" },
  { name: "sleep", description: "Consolidate memory and end this awakening" },
  { name: "help", description: "Show keyboard help" },
];

class HeaderComponent {
  #getView;
  #getSnapshot;
  constructor(getView, getSnapshot) { this.#getView = getView; this.#getSnapshot = getSnapshot; }
  invalidate() {}
  render(width) {
    const state = this.#getSnapshot();
    const status = state.status;
    const awake = status.awake && status.phase !== "falling-asleep";
    const pulse = awake ? `${COLORS.green}● AWAKE${COLORS.reset}` : `${COLORS.yellow}◐ ${String(status.phase || "ASLEEP").toUpperCase()}${COLORS.reset}`;
    const brand = `${COLORS.bold}${COLORS.white}REVO${COLORS.reset}  ${pulse}`;
    const activeCells = (status.workCells || []).filter((cell) => ["ready", "running", "interrupted"].includes(cell.state)).length;
    const usage = `${COLORS.muted}cycle ${status.cycle || 0}${activeCells ? `  ·  ${activeCells} cells` : ""}  ·  ${formatNumber(status.usage?.totalTokens || 0)} tok  ·  ${duration(status.elapsedMs || 0)}${COLORS.reset}`;
    const tabs = VIEWS.map((name, index) => {
      const count = name === "deliveries" && state.pendingDeliveries
        ? ` ${state.pendingDeliveries}`
        : name === "chat" && state.unrespondedOutreach ? ` ${state.unrespondedOutreach}` : "";
      const label = `${index + 1} ${name.toUpperCase()}${count}`;
      return name === this.#getView()
        ? `${ESC}48;2;38;53;60m${COLORS.cyan}${COLORS.bold} ${label} ${COLORS.reset}`
        : `${COLORS.muted} ${label} ${COLORS.reset}`;
    }).join("  ");
    const attention = `${COLORS.faint}└${COLORS.reset} ${COLORS.cyan}attention${COLORS.reset}  ${COLORS.white}${clean(state.selfState.attention || status.phase)}${COLORS.reset}`;
    return [fitSides(brand, usage, width), truncateToWidth(tabs, width), truncateToWidth(attention, width), ""];
  }
}

class TranscriptComponent {
  #getView;
  #getEvents;
  #getStatus;
  #getToolOutputExpanded;
  #projection = new ViewProjection();
  constructor(getView, getEvents, getStatus, getToolOutputExpanded = () => false) {
    this.#getView = getView;
    this.#getEvents = getEvents;
    this.#getStatus = getStatus;
    this.#getToolOutputExpanded = getToolOutputExpanded;
  }
  invalidate() { this.#projection.invalidate(); }
  render(width) {
    const status = this.#getStatus();
    return this.#projection.render(
      this.#getView(), this.#getEvents(), width, status.streamingText, status.phase, this.#getToolOutputExpanded(),
    );
  }
}

export class ViewProjection {
  #cache;
  invalidate() { this.#cache = undefined; }
  render(view, events, width, streamingText = "", phase = "", expandedTools = false) {
    const key = `${view}:${width}:${events.length}:${phase}:${streamingText}:${expandedTools}`;
    if (this.#cache?.key === key) return this.#cache.lines;
    const lines = projectView(view, events, Math.max(20, width - 2), streamingText, phase, { expandedTools })
      .map((line) => visualWidth(clean(line)) + 1 <= width ? ` ${line}` : truncateToWidth(` ${line}`, width));
    this.#cache = { key, lines };
    return lines;
  }
}

class FooterComponent {
  #getSnapshot;
  constructor(getSnapshot) { this.#getSnapshot = getSnapshot; }
  invalidate() {}
  render(width) {
    const state = this.#getSnapshot();
    const approval = state.approvals[0];
    if (approval) {
      return [
        truncateToWidth(`${COLORS.yellow}${COLORS.bold}  CONFIRM${COLORS.reset}  ${clean(approval.reason)}`, width),
        truncateToWidth(`${COLORS.muted}  Alt+Y approve  ·  Alt+N deny  ·  irreversible actions always stop here${COLORS.reset}`, width),
      ];
    }
    if (width < 100 && !state.notice) {
      return [truncateToWidth(`${COLORS.muted}  Tab complete  ·  Ctrl+T view  ·  Ctrl+O tools  ·  Ctrl+C sleep${COLORS.reset}`, width)];
    }
    const left = state.notice
      ? `${COLORS.cyan}  ${clean(state.notice)}${COLORS.reset}`
      : `${COLORS.muted}  Tab complete  ·  Shift+Enter newline  ·  Ctrl+O tools  ·  Ctrl+Shift+F search${COLORS.reset}`;
    const right = `${COLORS.muted}Alt+1/2/3 views  ·  Ctrl+C sleep${COLORS.reset}`;
    return [fitSides(left, right, width)];
  }
}

function editorTheme() {
  const identity = (text) => text;
  return {
    borderColor: (text) => `${COLORS.faint}${text}${COLORS.reset}`,
    selectList: {
      selectedPrefix: (text) => `${COLORS.cyan}${COLORS.bold}${text}${COLORS.reset}`,
      selectedText: (text) => `${COLORS.white}${COLORS.bold}${text}${COLORS.reset}`,
      description: (text) => `${COLORS.muted}${text}${COLORS.reset}`,
      scrollInfo: (text) => `${COLORS.faint}${text}${COLORS.reset}`,
      noMatch: (text) => `${COLORS.muted}${text}${COLORS.reset}`,
      match: identity,
    },
  };
}

function fitSides(left, right, width) {
  const gap = 2;
  const available = Math.max(1, width - visibleWidth(right) - gap);
  if (available < 18) return truncateToWidth(left, width);
  const clipped = truncateToWidth(left, available);
  return `${clipped}${" ".repeat(Math.max(gap, width - visibleWidth(clipped) - visibleWidth(right)))}${right}`;
}

export function renderPiFrame({ width, height, status, selfState, intentions = [], events = [], approvals = [], input = "", notice = "", view = "chat", expandedTools = false }) {
  width = Math.max(40, width);
  height = Math.max(12, height);
  const snapshot = {
    view, status, selfState, intentions, approvals, notice,
    pendingDeliveries: pendingDeliveries(events).length,
    unrespondedOutreach: unrespondedOutreach(events).length,
  };
  const header = new HeaderComponent(() => view, () => snapshot).render(width);
  const footer = new FooterComponent(() => snapshot).render(width);
  const fakeTui = { terminal: { rows: height }, requestRender() {}, getShowHardwareCursor() { return false; } };
  const editor = new Editor(fakeTui, editorTheme(), { paddingX: 1 });
  editor.setText(input);
  const editorLines = editor.render(width);
  const bodyHeight = Math.max(1, height - header.length - footer.length - editorLines.length);
  const projected = new ViewProjection().render(view, events, width, status.streamingText, status.phase, expandedTools);
  const body = projected.slice(Math.max(0, projected.length - bodyHeight));
  while (body.length < bodyHeight) body.push("");
  return [...header, ...body, ...footer, ...editorLines]
    .slice(0, height)
    .map((line) => padAnsi(line, width))
    .join("\n");
}

function chatLines(events, width, streamingText = "", phase = "") {
  const result = [];
  const visible = events.filter((item) => item.type === "user.message"
    || (item.type === "assistant.message" && (item.data.lane === "interaction" || item.data.proactive === false))
    || item.type === "proactive.message"
    || (item.type === "cycle.failed" && item.data.phase === "responding")
    || item.type === "delivery.created");
  for (const event of visible) {
    if (event.type === "delivery.created") {
      result.push(`${COLORS.yellow}${COLORS.bold}◆ DELIVERED${COLORS.reset}  ${COLORS.white}${clean(event.data.title)}${COLORS.reset}  ${COLORS.faint}${event.data.id.slice(0, 8)}${COLORS.reset}`, "");
      continue;
    }
    if (event.type === "cycle.failed") {
      result.push(`${COLORS.red}${COLORS.bold}REVO  reply interrupted${COLORS.reset}  ${COLORS.faint}${clock(event.at)}${COLORS.reset}`,
        ...wrap(`Your message is retained. ${clean(event.data.error)}. Retrying.`, Math.max(10, width - 2)).map((line) => `  ${line}`), "");
      continue;
    }
    if (event.type === "proactive.message") {
      result.push(`${COLORS.violet}${COLORS.bold}REVO  SPOKE FIRST${COLORS.reset}  ${COLORS.faint}${clock(event.at)} · ${clean(event.data.kind)}${COLORS.reset}`);
      result.push(...wrap(clean(event.data.text), Math.max(10, width - 2)).map((line) => `${COLORS.white}  ${line}${COLORS.reset}`), "");
      continue;
    }
    const human = event.type === "user.message";
    const role = human ? "YOU" : "REVO";
    const color = human ? COLORS.cyan : COLORS.green;
    result.push(`${color}${COLORS.bold}${role}${COLORS.reset}  ${COLORS.faint}${clock(event.at)}${COLORS.reset}`);
    result.push(...wrap(clean(event.data.text), Math.max(10, width - 2)).map((line) => `${COLORS.white}  ${line}${COLORS.reset}`), "");
  }
  if (streamingText) {
    result.push(`${COLORS.green}${COLORS.bold}REVO${COLORS.reset}  ${COLORS.faint}responding${COLORS.reset}`,
      ...wrap(clean(streamingText), Math.max(10, width - 2)).map((line) => `${COLORS.white}  ${line}${COLORS.reset}`),
      `${COLORS.green}  ▍${COLORS.reset}`);
  }
  if (!streamingText && phase === "responding") result.push(`${COLORS.green}${COLORS.bold}REVO${COLORS.reset}  ${COLORS.muted}responding...${COLORS.reset}`);
  if (result.length) return result;
  return wrap("No conversation yet. Revo remains active in LIFE.", width)
    .map((line) => `${COLORS.dim}${line}${COLORS.reset}`);
}

function lifeLines(events, width, expandedTools = false) {
  const result = [];
  for (const event of events) {
    if (event.type === "assistant.message" && event.data.lane !== "interaction" && event.data.proactive !== false) {
      result.push(`${COLORS.green}${COLORS.bold}REFLECTION${COLORS.reset}  ${COLORS.faint}${clock(event.at)}${COLORS.reset}`,
        ...wrap(clean(event.data.text), Math.max(10, width - 2)).map((line) => `${COLORS.white}  ${line}${COLORS.reset}`), "");
    } else if (event.type === "proactive.message") {
      result.push(`${COLORS.faint}${clock(event.at)}  ${COLORS.violet}↑${COLORS.reset}  spoke to human · ${clean(event.data.kind)}`);
    } else if (["environment.changed", "tool.completed", "tool.failed", "tool.reconciled", "memory.remembered", "self.updated", "cycle.failed", "work.cell.completed", "work.cell.failed", "work.cell.interrupted"].includes(event.type)) {
      const failed = event.type.endsWith("failed");
      result.push(`${COLORS.faint}${clock(event.at)}  ${failed ? COLORS.red : COLORS.muted}${failed ? "!" : "·"}${COLORS.reset}  ${eventLabel(event)}`);
      if (expandedTools && (event.type === "tool.completed" || event.type === "tool.failed")) {
        const evidence = formatToolEvidence(event.data.result);
        if (evidence) result.push(...wrap(evidence, Math.max(10, width - 4)).slice(0, 80).map((line) => `${COLORS.muted}    ${line}${COLORS.reset}`), "");
      }
    }
  }
  return result.length ? result : [`${COLORS.dim}No life activity recorded yet.${COLORS.reset}`];
}

function deliveryLines(events, width) {
  const acknowledged = new Set(events.filter((event) => event.type === "delivery.acknowledged").map((event) => event.data.id));
  const deliveries = events.filter((event) => event.type === "delivery.created");
  const result = [];
  for (const event of deliveries) {
    const status = acknowledged.has(event.data.id) ? "ACK" : "PENDING";
    result.push(`${COLORS.yellow}${COLORS.bold}${status === "ACK" ? "✓ ACKNOWLEDGED" : "◆ READY"}${COLORS.reset}  ${COLORS.faint}${event.data.id.slice(0, 8)}${COLORS.reset}`);
    result.push(`${COLORS.white}${COLORS.bold}${clean(event.data.title)}${COLORS.reset}`);
    result.push(...wrap(clean(event.data.summary), width).map((line) => `${COLORS.muted}${line}${COLORS.reset}`));
    result.push("");
    result.push(...wrap(clean(event.data.content), width));
    result.push("", `${COLORS.dim}:ack ${event.data.id}${COLORS.reset}`, "");
  }
  return result.length ? result : [`${COLORS.dim}No deliveries yet. Completed substantial work will remain here.${COLORS.reset}`];
}

export function projectView(view, events, width, streamingText = "", phase = "", { expandedTools = false } = {}) {
  if (view === "life") return lifeLines(events, width, expandedTools);
  if (view === "deliveries") return deliveryLines(events, width);
  return chatLines(events, width, streamingText, phase);
}

function pendingDeliveries(events) {
  const acknowledged = new Set(events.filter((event) => event.type === "delivery.acknowledged").map((event) => event.data.id));
  return events.filter((event) => event.type === "delivery.created" && !acknowledged.has(event.data.id));
}

function unrespondedOutreach(events) {
  const lastHumanSeq = events.filter((event) => event.type === "user.message").at(-1)?.seq ?? 0;
  return events.filter((event) => event.type === "proactive.message" && event.seq > lastHumanSeq);
}

function eventLabel(event) {
  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const target = event.data.arguments?.path || event.data.arguments?.command || "";
    return `${event.type === "tool.completed" ? COLORS.green : COLORS.red}${event.data.name}${COLORS.reset}${target ? `  ${COLORS.muted}${truncate(target, 80)}${COLORS.reset}` : ""}`;
  }
  if (event.type === "self.updated") return `${COLORS.cyan}focus${COLORS.reset}  ${clean(event.data.attention)}`;
  if (event.type === "environment.changed") return `${event.data.changes?.length || 0} environment changes`;
  if (event.type === "tool.reconciled") return `effect ${event.data.outcome}: ${event.data.intentId.slice(0, 8)}`;
  if (event.type.startsWith("work.cell.")) return `${COLORS.violet}cell${COLORS.reset} ${event.type.slice(10)}  ${String(event.data.id).slice(0, 8)}`;
  if (event.type === "model.completed") return `model call ${event.data.toolCalls?.length || 0} tools`;
  return event.type;
}

function formatToolEvidence(result) {
  if (!result) return "";
  const value = result.value ?? result.error ?? result;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return clean(text).slice(0, 20_000);
}

function clean(value) {
  return String(value ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function wrap(text, width) {
  const lines = [];
  for (const paragraph of clean(text).split(/\r?\n/)) {
    let line = "";
    let lineWidth = 0;
    for (const char of paragraph) {
      const widthOfChar = charWidth(char);
      if (lineWidth + widthOfChar > width) {
        lines.push(line);
        line = char;
        lineWidth = widthOfChar;
      } else {
        line += char;
        lineWidth += widthOfChar;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function truncate(text, width) {
  const value = clean(text);
  if (visualWidth(value) <= width) return value;
  const target = Math.max(0, width - 3);
  let result = "";
  for (const char of value) {
    if (visualWidth(result + char) > target) return result + "...";
    result += char;
  }
  return result;
}

function padAnsi(text, width) {
  const padding = Math.max(0, width - visualWidth(clean(text)));
  return text + " ".repeat(padding) + COLORS.reset;
}

function visualWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

function charWidth(char) {
  const code = char.codePointAt(0);
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff01 && code <= 0xff60)
    || (code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
}

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatNumber(value) { return Number(value || 0).toLocaleString("en-US"); }
function clock(value) { return CLOCK_FORMAT.format(new Date(value)); }
