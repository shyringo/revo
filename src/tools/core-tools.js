import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, relative, resolve } from "node:path";

export function registerCoreTools(registry, { workspace, memory, store, commandTimeoutMs, approvalMode = "destructive", communication = {}, workgraph }) {
  const add = (tool) => registry.register(tool);

  add({
    name: "ls",
    executionMode: "parallel",
    description: "List files and directories inside the workspace.",
    parameters: object({ path: string("Relative directory path; default is workspace root"), limit: integer("Maximum entries; default 100, maximum 500") }),
    async execute({ path = ".", limit = 100 }) {
      const target = await inside(workspace, path);
      const entries = await readdir(target, { withFileTypes: true });
      return entries.filter((entry) => entry.name !== ".revo").slice(0, clamp(limit, 1, 500)).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
    },
  });

  add({
    name: "read",
    executionMode: "parallel",
    description: "Read a UTF-8 text file inside the workspace, optionally by line range.",
    parameters: object({
      path: string("Relative file path", true),
      offset: integer("First line, one-based"),
      limit: integer("Maximum number of lines; default 400, maximum 2000"),
    }, ["path"]),
    async execute({ path, offset = 1, limit = 400 }) {
      const text = await readFile(await inside(workspace, path), "utf8");
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, offset - 1);
      if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
      const count = clamp(limit, 1, 2_000);
      const selected = lines.slice(start, start + count).join("\n");
      const output = truncateBytes(selected, 50 * 1024);
      const next = start + count < lines.length ? start + count + 1 : null;
      return `${output}${next ? `\n\n[${lines.length - start - count} more lines. Use offset=${next} to continue.]` : ""}`;
    },
  });

  add({
    name: "write",
    description: "Create or completely rewrite a UTF-8 text file inside the workspace. Prefer edit for precise changes.",
    parameters: object({ path: string("Relative file path", true), content: string("Complete file content", true) }, ["path", "content"]),
    async requiresApproval({ path }) { return approvalMode === "always" ? `Write ${path}` : false; },
    async execute({ path, content }) {
      const target = await inside(workspace, path, true);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(content), { encoding: "utf8" });
      return { path: relative(workspace, target).replaceAll("\\", "/"), bytes: Buffer.byteLength(String(content)) };
    },
  });

  add({
    name: "edit",
    description: "Make precise edits to one text file. Each edits[].oldText must occur exactly once in the original file; replacements must not overlap.",
    parameters: object({
      path: string("Relative file path", true),
      edits: array(object({ oldText: string("Exact original text", true), newText: string("Replacement text") }, ["oldText", "newText"]), "One or more exact replacements", 1),
    }, ["path", "edits"]),
    requiresApproval({ path }) { return approvalMode === "always" ? `Edit ${path}` : false; },
    async execute({ path, edits }, { signal }) {
      signal?.throwIfAborted();
      const target = await inside(workspace, path);
      const raw = await readFile(target, "utf8");
      signal?.throwIfAborted();
      const bom = raw.startsWith("\ufeff") ? "\ufeff" : "";
      const source = (bom ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
      const ending = /\r\n/.test(raw) ? "\r\n" : "\n";
      const located = edits.map((item, index) => {
        const oldText = item.oldText.replace(/\r\n/g, "\n");
        const first = source.indexOf(oldText);
        if (first < 0) throw new Error(`edits[${index}].oldText was not found in ${path}`);
        if (source.indexOf(oldText, first + 1) >= 0) throw new Error(`edits[${index}].oldText is not unique in ${path}`);
        return { start: first, end: first + oldText.length, newText: item.newText.replace(/\r\n/g, "\n"), index };
      }).sort((a, b) => a.start - b.start);
      for (let index = 1; index < located.length; index++) {
        if (located[index].start < located[index - 1].end) throw new Error("Edits overlap; merge nearby changes into one replacement");
      }
      let result = source;
      for (const item of located.toReversed()) result = result.slice(0, item.start) + item.newText + result.slice(item.end);
      signal?.throwIfAborted();
      await writeFile(target, bom + result.replace(/\n/g, ending), "utf8");
      return { path: relative(workspace, target).replaceAll("\\", "/"), replacements: located.length };
    },
  });

  add({
    name: "grep",
    executionMode: "parallel",
    description: "Search UTF-8 workspace files for a literal text fragment.",
    parameters: object({
      query: string("Literal text to find", true),
      path: string("Relative directory; default workspace"),
      maxResults: integer("Maximum matches; default 30, maximum 200"),
      maxFiles: integer("Maximum text files to inspect; default 200, maximum 5000"),
    }, ["query"]),
    async execute({ query, path = ".", maxResults = 30, maxFiles = 200 }) {
      const matches = [];
      const limit = clamp(maxResults, 1, 200);
      const fileLimit = clamp(maxFiles, 1, 5_000);
      let scannedFiles = 0;
      await walkText(await inside(workspace, path), async (file) => {
        if (matches.length >= limit || scannedFiles >= fileLimit) return false;
        scannedFiles += 1;
        let text;
        try { text = await readFile(file, "utf8"); } catch { return true; }
        text.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < limit && line.includes(query)) matches.push({ path: relative(workspace, file).replaceAll("\\", "/"), line: index + 1, text: line.slice(0, 240) });
        });
        return matches.length < limit && scannedFiles < fileLimit;
      });
      return { matches, scannedFiles, truncated: matches.length >= limit || scannedFiles >= fileLimit };
    },
  });

  add({
    name: "bash",
    description: process.platform === "win32"
      ? "Run a Windows PowerShell 5.1 command in the workspace. Routine commands execute directly; destructive commands require confirmation."
      : "Run a POSIX shell command in the workspace. Routine commands execute directly; destructive commands require confirmation.",
    parameters: object({ command: string("Exact command to run", true), timeout: number("Optional timeout in seconds") }, ["command"]),
    requiresApproval({ command }) {
      if (approvalMode === "always") return `Run this command in the workspace: ${command}`;
      return destructiveCommandReason(command);
    },
    async execute({ command, timeout }, { signal }) {
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
      const result = await runCommand(shell, args, { cwd: workspace, timeout: timeout ? clamp(timeout, 1, 600) * 1000 : commandTimeoutMs, signal });
      return { exitCode: result.exitCode, stdout: truncateTail(result.stdout, 50 * 1024), stderr: truncateTail(result.stderr, 20 * 1024) };
    },
  });

  add({
    name: "remember",
    description: "Store a durable fact, preference, lesson, or commitment across sleep and wake cycles.",
    parameters: object({ text: string("Memory to retain", true), kind: string("semantic, episodic, preference, or lesson"), salience: number("Importance from 0 to 1") }, ["text"]),
    execute({ text, kind = "semantic", salience = 0.6 }) { return memory.remember(text, kind, salience); },
  });

  add({
    name: "set_intention",
    description: "Create a durable intention that Revo should revisit until completed.",
    parameters: object({ title: string("Concise intention", true), nextAction: string("Concrete next action"), priority: number("Priority from 0 to 1") }, ["title"]),
    async execute({ title, nextAction = "", priority = 0.5 }) {
      const data = { id: crypto.randomUUID(), title, nextAction, priority: Math.max(0, Math.min(1, Number(priority))) };
      await store.append("intention.created", data);
      return data;
    },
  });

  add({
    name: "complete_intention",
    description: "Mark a durable intention complete.",
    parameters: object({ id: string("Intention id", true), outcome: string("What happened") }, ["id"]),
    async execute({ id, outcome = "" }) {
      await store.append("intention.completed", { id, outcome });
      return { id, completed: true };
    },
  });

  add({
    name: "update_self_state",
    description: "Update Revo's current attention, self-assessment, and most important open question.",
    parameters: object({
      attention: string("What currently deserves attention", true),
      assessment: string("What changed in your understanding"),
      openQuestion: string("The highest-value unresolved question"),
      rationale: string("Why this attention serves the Constitution, a human instruction, an intention, or a necessary information gap"),
    }, ["attention"]),
    async execute({ attention, assessment = "", openQuestion = "", rationale = "" }) {
      const data = { attention, assessment, openQuestion, rationale };
      await store.append("self.updated", data);
      return data;
    },
  });

  add({
    name: "deliver_to_user",
    description: "Create a durable, discoverable delivery for completed substantial human-directed work. Use this instead of relying on ordinary chat narration.",
    parameters: object({
      title: string("Short delivery title", true),
      summary: string("Concise outcome summary", true),
      content: string("Complete delivery content, results, paths, and verification", true),
      intentionId: string("Related intention id, when applicable"),
    }, ["title", "summary", "content"]),
    async execute({ title, summary, content, intentionId = "" }) {
      const data = { id: crypto.randomUUID(), title, summary, content, intentionId, createdAt: new Date().toISOString() };
      await store.append("delivery.created", data);
      return { id: data.id, delivered: true };
    },
  });

  add({
    name: "speak_to_user",
    description: "Proactively address the human in CHAT when a new discovery, question, milestone, risk, or decision genuinely deserves their attention. This is not routine narration and does not resolve human obligations.",
    parameters: object({
      text: string("The concise message the human should see", true),
      kind: string("discovery, question, milestone, risk, or decision", true),
      whyNow: string("Why this deserves the human's attention now instead of remaining in LIFE", true),
    }, ["text", "kind", "whyNow"]),
    async execute({ text, kind, whyNow }) {
      const allowed = new Set(["discovery", "question", "milestone", "risk", "decision"]);
      if (!allowed.has(kind)) throw new Error(`Invalid proactive communication kind: ${kind}`);
      const message = String(text).trim();
      const rationale = String(whyNow).trim();
      if (message.length < 4) throw new Error("Proactive communication must contain a meaningful message");
      if (rationale.length < 8) throw new Error("Proactive communication must explain why speaking now is worthwhile");
      const now = Date.now();
      const prior = store.byType("proactive.message");
      const recentHour = prior.filter((event) => now - Date.parse(event.at) < 3_600_000);
      const maxPerHour = Math.floor(clamp(communication.proactiveMaxPerHour ?? 4, 1, 20));
      if (recentHour.length >= maxPerHour) {
        return { sent: false, suppressed: "hourly attention budget", retryAfterMs: Math.max(0, 3_600_000 - (now - Date.parse(recentHour[0].at))) };
      }
      const normalized = normalizeMessage(message);
      if (prior.slice(-20).some((event) => normalizeMessage(event.data.text) === normalized)) {
        return { sent: false, suppressed: "duplicate message" };
      }
      const last = prior.at(-1);
      const minIntervalMs = Math.max(0, Number(communication.proactiveMinIntervalMs ?? 300_000));
      if (last && now - Date.parse(last.at) < minIntervalMs) {
        return { sent: false, suppressed: "attention cooldown", retryAfterMs: minIntervalMs - (now - Date.parse(last.at)) };
      }
      const data = { id: crypto.randomUUID(), text: message, kind, whyNow: rationale, createdAt: new Date(now).toISOString() };
      await store.append("proactive.message", data);
      return { id: data.id, sent: true };
    },
  });

  add({
    name: "resolve_human_input",
    description: "Resolve one durable human obligation only after its conversation was fully answered, its requested work was completed, or it was superseded. Acknowledgement alone is insufficient.",
    parameters: object({
      messageSeq: integer("Sequence number of the user.message being resolved"),
      disposition: string("response_only, completed, or superseded", true),
      outcome: string("Specific evidence for why the obligation is resolved", true),
      deliveryId: string("Required reference for substantial completed work"),
      supersededBySeq: integer("Required later user.message seq when disposition is superseded"),
    }, ["messageSeq", "disposition", "outcome"]),
    async execute({ messageSeq, disposition, outcome, deliveryId = "", supersededBySeq }) {
      if (!["response_only", "completed", "superseded"].includes(disposition)) throw new Error("Invalid human-input disposition");
      const message = store.all().find((event) => event.seq === messageSeq && event.type === "user.message");
      if (!message) throw new Error(`Human input ${messageSeq} does not exist`);
      const prior = store.byType("human.input.resolved").find((event) => event.data.messageSeq === messageSeq);
      if (prior) return { messageSeq, alreadyResolved: true };
      if (deliveryId && !store.byType("delivery.created").some((event) => event.data.id === deliveryId)) throw new Error(`Delivery ${deliveryId} does not exist`);
      if (disposition === "superseded") {
        const superseding = store.all().find((event) => event.seq === supersededBySeq && event.type === "user.message");
        if (!superseding || superseding.seq <= messageSeq) throw new Error("Superseded obligations require a real later human input");
      }
      const data = { messageSeq, disposition, outcome, deliveryId, supersededBySeq, resolvedAt: new Date().toISOString() };
      await store.append("human.input.resolved", data);
      return data;
    },
  });

  add({
    name: "resolve_unknown_effect",
    description: "Reconcile a crash-time tool intent only after inspecting real-world evidence. Never use this to guess or blindly replay the action.",
    parameters: object({
      intentId: string("tool.intent event id", true),
      outcome: string("confirmed_succeeded, confirmed_failed, no_effect, or still_unknown", true),
      evidence: string("Concrete observation supporting the outcome", true),
    }, ["intentId", "outcome", "evidence"]),
    async execute({ intentId, outcome, evidence }) {
      if (!["confirmed_succeeded", "confirmed_failed", "no_effect", "still_unknown"].includes(outcome)) throw new Error("Invalid reconciliation outcome");
      if (!store.byType("tool.intent").some((event) => event.id === intentId)) throw new Error(`Tool intent ${intentId} does not exist`);
      const data = { intentId, outcome, evidence, reconciledAt: new Date().toISOString() };
      await store.append("tool.reconciled", data);
      return data;
    },
  });

  if (workgraph) {
    add({
      name: "open_work_cell",
      description: "Request admission for a bounded parallel cognitive process in Revo's shared work graph. It is not a sub-agent or session and cannot act on the world or speak to the human. Admission may be refused when outstanding work reaches capacity; integrate or cancel existing work instead of retrying blindly.",
      parameters: object({
        objective: string("One independently computable objective", true),
        context: string("Small self-contained context needed for the objective"),
        dependsOn: array(string("Work-cell id"), "Cells whose completed outputs are required"),
        maxOutputTokens: integer("Output budget from 256 to 4096 tokens"),
      }, ["objective"]),
      execute(args) { return workgraph.open(args); },
    });
    add({
      name: "cancel_work_cell",
      description: "Cancel an obsolete or superseded work-graph cell.",
      parameters: object({ id: string("Work-cell id", true), reason: string("Why it is no longer needed", true) }, ["id", "reason"]),
      execute({ id, reason }) { return workgraph.cancel(id, reason); },
    });
    add({
      name: "resume_work_cell",
      description: "Explicitly resume an interrupted or failed work cell after reconsidering it against newer human input and shared life.",
      parameters: object({ id: string("Work-cell id", true), context: string("Updated compact context replacing stale assumptions") }, ["id"]),
      execute({ id, context = "" }) { return workgraph.resumeCell(id, context); },
    });
  }
}

async function inside(root, path = ".", allowMissing = false) {
  const rootReal = await realpath(resolve(root));
  const target = resolve(rootReal, path);
  assertInside(rootReal, target);
  try {
    const targetReal = await realpath(target);
    assertInside(rootReal, targetReal);
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT") throw error;
    let ancestor = dirname(target);
    while (true) {
      try {
        assertInside(rootReal, await realpath(ancestor));
        break;
      } catch (ancestorError) {
        if (ancestorError.code !== "ENOENT") throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new Error("Cannot resolve a safe parent directory");
        ancestor = parent;
      }
    }
  }
  return target;
}

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || (rel && resolve(rel) === rel)) {
    throw new Error("Path escapes the workspace");
  }
  const first = rel.split(/[\\/]/, 1)[0]?.toLowerCase();
  if (first === ".revo") throw new Error("Managed Revo state is not directly accessible through workspace file tools");
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}

async function walkText(directory, visit) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if ([".git", ".revo", "node_modules", "coverage"].includes(entry.name)) continue;
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (await walkText(full, visit) === false) return false;
    }
    else if (entry.isFile()) {
      try { if ((await stat(full)).size <= 2 * 1024 * 1024 && await visit(full) === false) return false; } catch { /* Ignore races. */ }
    }
  }
  return true;
}

function runCommand(file, args, options) {
  return new Promise((resolveRun, reject) => {
    execFile(file, args, { ...options, maxBuffer: 2 * 1024 * 1024 }, (error, stdout = "", stderr = "") => {
      if (error?.code === "ABORT_ERR" || error?.killed || error?.signal) return reject(error);
      if (error && typeof error.code !== "number") return reject(error);
      resolveRun({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

function destructiveCommandReason(command) {
  const text = String(command);
  const patterns = process.platform === "win32"
    ? [
        /(^|[|;&\s])Remove-Item\b/i, /(^|[|;&\s])(del|erase|rd|rmdir|rm|ri)\b/i,
        /\b(Clear-Content|Format-Volume|Clear-Disk|Initialize-Disk|Uninstall-Package)\b/i,
        /\bgit\s+(clean\b|reset\s+--hard\b|branch\s+-D\b|checkout\s+--(?:\s|$)|restore\b)/i,
      ]
    : [
        /(^|[|;&\s])(rm|rmdir|unlink|shred)\b/, /\btruncate\s+-s\s*0\b/, /\bfind\b[^\n]*\s-delete\b/,
        /\bgit\s+(clean\b|reset\s+--hard\b|branch\s+-D\b|checkout\s+--(?:\s|$)|restore\b)/,
      ];
  return patterns.some((pattern) => pattern.test(text))
    ? `This command may delete data or history and needs explicit confirmation: ${text}`
    : false;
}

function normalizeMessage(value) {
  return String(value).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function object(properties, required = []) { return { type: "object", properties, required, additionalProperties: false }; }
function array(items, description, minItems = 0) { return { type: "array", items, description, minItems }; }
function string(description, required = false) { return { type: "string", description, ...(required ? { minLength: 1 } : {}) }; }
function number(description) { return { type: "number", description }; }
function integer(description) { return { type: "integer", description, minimum: 1 }; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || min)); }
function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`;
}

function truncateBytes(value, limit) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= limit) return buffer.toString("utf8");
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}\n...[truncated at ${limit} bytes]`;
}

function truncateTail(value, limit) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= limit) return buffer.toString("utf8");
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return `...[truncated ${start} bytes]\n${buffer.subarray(start).toString("utf8")}`;
}
