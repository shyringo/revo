import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/core/event-store.js";
import { ApprovalQueue } from "../src/core/approvals.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { registerCoreTools } from "../src/tools/core-tools.js";

test("pi-style write creates and replaces files without routine approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-tools-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const approvals = new ApprovalQueue(store);
  const registry = new ToolRegistry({ approvals, store });
  registerCoreTools(registry, {
    workspace,
    memory: { remember: async () => ({}) },
    store,
    runtime: { requestWake: () => ({}) },
    commandTimeoutMs: 1000,
  });

  const created = await registry.execute("write", { path: "sample.txt", content: "first" });
  assert.equal(created.ok, true);
  const replacement = await registry.execute("write", { path: "sample.txt", content: "second" });
  assert.equal(replacement.ok, true);
  assert.equal(approvals.list().length, 0);
  assert.equal(await readFile(join(workspace, "sample.txt"), "utf8"), "second");
});

test("file tools reject paths outside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-path-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  const approvals = new ApprovalQueue(store);
  const registry = new ToolRegistry({ approvals, store });
  registerCoreTools(registry, {
    workspace,
    memory: { remember: async () => ({}) }, store,
    runtime: { requestWake: () => ({}) }, commandTimeoutMs: 1000,
  });
  const result = await registry.execute("read", { path: "../outside.txt" });
  assert.equal(result.ok, false);
  assert.match(result.error, /escapes the workspace/);
});

test("workspace tools keep managed life state behind the memory boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-managed-state-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const approvals = new ApprovalQueue(store);
  const registry = new ToolRegistry({ approvals, store });
  registerCoreTools(registry, {
    workspace, memory: { remember: async () => ({}) }, store,
    commandTimeoutMs: 1000,
  });
  const listed = await registry.execute("ls", {});
  assert.deepEqual(listed.value, []);
  const read = await registry.execute("read", { path: ".revo/events.jsonl" });
  assert.equal(read.ok, false);
  assert.match(read.error, /Managed Revo state/);
});

test("substantial work can be committed as a durable delivery", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-delivery-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const result = await registry.execute("deliver_to_user", { title: "Report", summary: "Done", content: "Complete result" });
  assert.equal(result.ok, true);
  const delivery = store.byType("delivery.created")[0];
  assert.equal(delivery.data.title, "Report");
  assert.equal(delivery.data.content, "Complete result");
});

test("human input remains an obligation until explicitly resolved", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-human-obligation-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  const input = await store.append("user.message", { text: "prepare a report" });
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const delivery = await registry.execute("deliver_to_user", { title: "Report", summary: "Done", content: "Result" });
  const resolved = await registry.execute("resolve_human_input", {
    messageSeq: input.seq, disposition: "completed", outcome: "Report delivered", deliveryId: delivery.value.id,
  });
  assert.equal(resolved.ok, true);
  assert.equal(store.byType("human.input.resolved")[0].data.messageSeq, input.seq);
});

test("superseding a human obligation requires a real later human message", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-human-supersede-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const first = await store.append("user.message", { text: "do A" });
  const later = await store.append("user.message", { text: "do B instead" });
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const invalid = await registry.execute("resolve_human_input", { messageSeq: first.seq, disposition: "superseded", outcome: "claimed" });
  assert.equal(invalid.ok, false);
  const valid = await registry.execute("resolve_human_input", { messageSeq: first.seq, disposition: "superseded", outcome: "user replaced A", supersededBySeq: later.seq });
  assert.equal(valid.ok, true);
});

test("tool intent is durable before effect and settles only when result commits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-tool-intent-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const result = await registry.run("ls", {});
  assert.equal(store.byType("tool.intent").length, 1);
  assert.equal(store.byType("tool.completed").length, 0);
  await registry.record("ls", {}, result);
  assert.equal(store.byType("tool.completed")[0].data.intentId, store.byType("tool.intent")[0].id);
});

test("unknown effect reconciliation requires a real intent and explicit evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-tool-reconcile-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  const intent = await store.append("tool.intent", { name: "write", arguments: {} });
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const result = await registry.execute("resolve_unknown_effect", { intentId: intent.id, outcome: "no_effect", evidence: "target file is absent" });
  assert.equal(result.ok, true);
  assert.equal(store.byType("tool.reconciled")[0].data.evidence, "target file is absent");
});

test("text search stops at its explicit file budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-search-budget-"));
  for (let index = 0; index < 5; index++) await writeFile(join(workspace, `file-${index}.txt`), "needle");
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const result = await registry.execute("grep", { query: "needle", maxFiles: 2, maxResults: 30 });
  assert.equal(result.value.scannedFiles, 2);
  assert.equal(result.value.matches.length, 2);
  assert.equal(result.value.truncated, true);
});

test("approval cannot survive restart without an explicit human decision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-approval-recovery-"));
  const store = await new EventStore(join(workspace, "events.jsonl")).open();
  await store.append("approval.requested", { id: "pending", tool: "bash" });
  const approvals = new ApprovalQueue(store);
  await approvals.recover();
  assert.equal(store.byType("approval.expired")[0].data.id, "pending");
  await approvals.recover();
  assert.equal(store.byType("approval.expired").length, 1, "recovery is idempotent");
});

test("tool arguments are enforced before approval, intent, or side effect", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-tool-validation-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const missing = await registry.execute("write", { path: "bad.txt" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /content is required/);
  assert.equal(store.byType("approval.requested").length, 0);
  assert.equal(store.byType("tool.intent").length, 0);
  await assert.rejects(readFile(join(workspace, "bad.txt")), /ENOENT/);
});

test("pi-style edit applies disjoint replacements and preserves BOM and CRLF", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-edit-"));
  await writeFile(join(workspace, "sample.txt"), "\ufeffone\r\ntwo\r\nthree\r\n", "utf8");
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const result = await registry.execute("edit", {
    path: "sample.txt",
    edits: [{ oldText: "one", newText: "ONE" }, { oldText: "three", newText: "THREE" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.replacements, 2);
  assert.equal(await readFile(join(workspace, "sample.txt"), "utf8"), "\ufeffONE\r\ntwo\r\nTHREE\r\n");
});

test("edit rejects ambiguous text and array arguments are validated before effects", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-edit-unique-"));
  await writeFile(join(workspace, "sample.txt"), "same same", "utf8");
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000 });
  const empty = await registry.execute("edit", { path: "sample.txt", edits: [] });
  assert.match(empty.error, /at least 1 item/);
  assert.equal(store.byType("tool.intent").length, 0);
  const ambiguous = await registry.execute("edit", { path: "sample.txt", edits: [{ oldText: "same", newText: "new" }] });
  assert.match(ambiguous.error, /not unique/);
  assert.equal(await readFile(join(workspace, "sample.txt"), "utf8"), "same same");
});

test("routine bash is approval-free while destructive commands stop for confirmation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-bash-policy-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const approvals = new ApprovalQueue(store);
  const registry = new ToolRegistry({ approvals, store });
  registerCoreTools(registry, { workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 30000 });
  const routine = await registry.execute("bash", { command: process.platform === "win32" ? "Write-Output hello" : "printf hello" });
  assert.equal(routine.ok, true);
  assert.match(routine.value.stdout, /hello/);
  assert.equal(approvals.list().length, 0);
  const destructive = registry.execute("bash", { command: process.platform === "win32" ? "Remove-Item sample.txt" : "rm sample.txt" });
  await waitFor(() => approvals.list().length === 1);
  await approvals.decide(approvals.list()[0].id, false, "deletion not approved");
  assert.equal((await destructive).denied, true);
});

test("proactive speech is durable, throttled, and separate from human obligations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-outreach-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const human = await store.append("user.message", { text: "keep working" });
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, {
    workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000,
    communication: { proactiveMinIntervalMs: 60_000, proactiveMaxPerHour: 4 },
  });
  const first = await registry.execute("speak_to_user", {
    text: "I found a material contradiction in the design.", kind: "discovery",
    whyNow: "Resolving it now changes the architecture decision.",
  });
  assert.equal(first.value.sent, true);
  assert.equal(store.byType("proactive.message").length, 1);
  const duplicate = await registry.execute("speak_to_user", {
    text: "I found a material contradiction in the design.", kind: "discovery",
    whyNow: "This would otherwise repeat the same interruption.",
  });
  assert.equal(duplicate.value.suppressed, "duplicate message");
  const cooled = await registry.execute("speak_to_user", {
    text: "A second observation can wait.", kind: "discovery",
    whyNow: "This test proves the attention cooldown remains durable.",
  });
  assert.equal(cooled.value.suppressed, "attention cooldown");
  assert.equal(store.byType("human.input.resolved").length, 0);
  assert.equal(store.byType("user.message")[0].seq, human.seq);
});

test("proactive speech enforces its hourly human-attention budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "revo-outreach-budget-"));
  const store = await new EventStore(join(workspace, ".revo", "events.jsonl")).open();
  const registry = new ToolRegistry({ approvals: new ApprovalQueue(store), store });
  registerCoreTools(registry, {
    workspace, memory: { remember: async () => ({}) }, store, commandTimeoutMs: 1000,
    communication: { proactiveMinIntervalMs: 0, proactiveMaxPerHour: 2 },
  });
  for (const text of ["First worthwhile discovery.", "Second worthwhile discovery."]) {
    const result = await registry.execute("speak_to_user", { text, kind: "discovery", whyNow: "It materially changes what the human should know now." });
    assert.equal(result.value.sent, true);
  }
  const third = await registry.execute("speak_to_user", {
    text: "Third interruption should wait.", kind: "milestone", whyNow: "The hourly cap should suppress this otherwise valid message.",
  });
  assert.equal(third.value.suppressed, "hourly attention budget");
  assert.equal(store.byType("proactive.message").length, 2);
});

async function waitFor(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
