#!/usr/bin/env node
import { dirname, join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { Kernel } from "./core/kernel.js";
import { loadConfig } from "./core/config.js";
import { loadPlugins } from "./core/plugin-loader.js";
import { acquireLifeLock } from "./core/life-lock.js";
import { findDelivery, formatDelivery, formatOfflineStatus, projectOfflineStatus } from "./core/offline-status.js";
import { verifyStateIntegrity } from "./core/integrity.js";
import { EventStore } from "./core/event-store.js";
import { ApprovalQueue } from "./core/approvals.js";
import { LifeRuntime } from "./core/life-runtime.js";
import { WorkGraph } from "./core/workgraph.js";
import { Memory } from "./memory/memory.js";
import { OpenAICompatibleModel } from "./model/openai-compatible.js";
import { WorkspaceSensor } from "./sensors/workspace.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerCoreTools } from "./tools/core-tools.js";
import { Tui } from "./tui/tui.js";

let tui;
let fatal = false;
process.on("uncaughtException", failCleanly);
process.on("unhandledRejection", failCleanly);

function failCleanly(error) {
  if (fatal) return;
  fatal = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Revo failed: ${message}\n`);
  process.stderr.write("Next: run `revo --doctor` to check this installation, or `revo --status` to see what Revo already did.\n");
  // Report the real failure before any teardown, and never let teardown replace it.
  try { tui?.close(); } catch { /* the original error is what the human needs to see */ }
  process.exitCode = 1;
  const failStop = setTimeout(() => process.exit(1), 1_000);
  failStop.unref();
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log("revo [--for 30m] [--token-budget 200000] [--doctor] [--status [--json]] [--delivery <id|latest> [--json]]\n\nRevo stays continuously awake until Ctrl+C, :sleep, or a configured limit.");
  process.exit(0);
}
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(manifest.version);
  process.exit(0);
}

const config = loadConfig();
const cli = applyArguments(config, rawArgs);
if (cli.json && !cli.status && !cli.delivery) throw new Error("--json is only valid with --status or --delivery");
if (cli.doctor) {
  await runDoctor(config);
  await endProcessGracefully();
}
if (cli.status) {
  await printOfflineStatus(config, cli.json);
  process.exit(0);
}
if (cli.delivery) {
  await printOfflineDelivery(config, cli.delivery, cli.json);
  process.exit(0);
}
enforceModelLock(config);
if (!config.model.apiKey) {
  console.error([
    "NO MIND: Revo has no model credential, so it cannot wake.",
    "",
    "  Next: give it one and start again:",
    '    bash/zsh:    export REVO_API_KEY="<your key>"',
    '    PowerShell:  $env:REVO_API_KEY = "<your key>"',
    '  ...or put {"model":{"apiKey":"<your key>"}} in your config file (REVO_CONFIG).',
    "",
    "  You can read what Revo already did without any credential:",
    "    revo --status          what this installation is and has done",
    "    revo --doctor          checks every prerequisite",
    "    revo --delivery latest the last durable result",
  ].join("\n"));
  process.exit(1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error([
    "NO SCREEN: Revo's TUI needs an interactive terminal, and stdin/stdout here are piped or redirected.",
    "",
    "  Next: run it directly in a terminal window, e.g.  revo --for 5m",
    "",
    "  Without a terminal you can still use:",
    "    revo --doctor          checks every prerequisite",
    "    revo --status          what this installation is and has done",
    "    revo --delivery latest the last durable result",
  ].join("\n"));
  process.exit(1);
}
const lifeLock = await acquireLifeLock(config.stateDir);

function enforceModelLock(config) {
  if (!config.model.locked) return;
  const baseUrl = config.model.baseUrl.replace(/\/$/, "");
  if (baseUrl !== "https://opencode.ai/zen/go/v1" || config.model.name !== "deepseek-v4-flash") {
    throw new Error("This Revo installation is locked to OpenCode Go deepseek-v4-flash");
  }
}
const kernel = new Kernel();
const store = await new EventStore(join(config.stateDir, "life.jsonl")).open();
const publish = (type, data) => runtime?.emit("event", { type, data, at: new Date().toISOString() });
const approvals = new ApprovalQueue(store, publish);
await approvals.recover();
const memory = new Memory(store);
const model = new OpenAICompatibleModel(config.model);
const tools = new ToolRegistry({ approvals, store });
const sensor = new WorkspaceSensor(config.workspace);
const workgraph = new WorkGraph({ config, store, model });
const runtime = new LifeRuntime({ config, store, model, memory, tools, sensor, workgraph });
workgraph.on("usage", (usage) => runtime.accountUsage(usage));

registerCoreTools(tools, {
  workspace: config.workspace,
  memory,
  store,
  commandTimeoutMs: config.policy.commandTimeoutMs,
  approvalMode: config.policy.approvalMode,
  communication: config.communication,
  workgraph,
});

await kernel.use({
  name: "revo-core",
  async mount(context) {
    const disposers = [
      context.provide("config", config),
      context.provide("events", store),
      context.provide("memory", memory),
      context.provide("tools", tools),
      context.provide("approvals", approvals),
      context.provide("runtime", runtime),
      context.provide("workgraph", workgraph),
    ];
    return () => disposers.reverse().forEach((dispose) => dispose());
  },
});
await loadPlugins(kernel, config.plugins, config.configPath ? dirname(config.configPath) : process.cwd());

let shutdownPromise;
async function forceClose() {
  try { await shutdown({ forced: true }); }
  finally { process.exit(130); }
}

tui = new Tui({ runtime, store, approvals, forceExit: forceClose });
tui.start();
process.on("SIGTERM", () => runtime.requestSleep("process received SIGTERM"));

try {
  await runtime.start();
  await runtime.wait();
} finally {
  await shutdown();
}

function shutdown({ forced = false } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const errors = [];
    const attempt = async (operation) => {
      try { await operation(); }
      catch (error) { errors.push(error); }
    };
    await attempt(() => approvals.close());
    await attempt(() => workgraph.close());
    try { tui?.close(); } catch (error) { errors.push(error); }
    if (forced) await attempt(() => store.append("life.forced_sleep", { at: new Date().toISOString() }));
    await attempt(() => kernel.close());
    await attempt(() => store.flush());
    if (!forced && errors.length === 0 && store.byType("life.awoke", "life.slept").at(-1)?.type === "life.slept") {
      await attempt(() => store.checkpoint(join(config.stateDir, "snapshots")));
    }
    await attempt(() => lifeLock.release());
    if (errors.length) throw new AggregateError(errors, "Revo shutdown failed");
  })();
  return shutdownPromise;
}

function applyArguments(target, args) {
  let doctor = false;
  let status = false;
  let json = false;
  let delivery = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--for") target.life.durationMs = parseDuration(args[++index]);
    else if (arg === "--token-budget") target.life.tokenBudget = parsePositive(args[++index], "token budget");
    else if (arg === "--doctor") doctor = true;
    else if (arg === "--status") status = true;
    else if (arg === "--delivery") {
      const selector = args[index + 1];
      if (selector && !selector.startsWith("--")) { delivery = selector; index += 1; }
      else delivery = "latest";
    }
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { doctor, status, json, delivery };
}

async function printOfflineStatus(config, json) {
  const path = join(config.stateDir, "life.jsonl");
  try { await access(path); }
  catch {
    const unborn = { identity: null, state: "unborn", obligations: [], pendingDeliveries: [], unrespondedOutreach: [], unknownEffects: [], workgraph: { total: 0, active: 0, completed: 0, failed: 0 }, lifetimeTokens: 0, events: 0 };
    console.log(json ? JSON.stringify(unborn, null, 2) : formatOfflineStatus(unborn));
    return;
  }
  const offlineStore = await new EventStore(path).open();
  const status = projectOfflineStatus(offlineStore);
  console.log(json ? JSON.stringify(status, null, 2) : formatOfflineStatus(status));
}

async function printOfflineDelivery(config, selector, json) {
  const path = join(config.stateDir, "life.jsonl");
  try { await access(path); }
  catch { throw new Error("Revo has no life log in this state directory"); }
  const offlineStore = await new EventStore(path).open();
  const delivery = findDelivery(offlineStore, selector);
  if (!delivery) throw new Error(`Delivery not found: ${selector}`);
  console.log(json ? JSON.stringify(delivery, null, 2) : formatDelivery(delivery));
}

async function runDoctor(config) {
  const checks = [];
  checks.push(["configuration", true, config.configPath || "environment and built-in defaults"]);
  checks.push(["credential", Boolean(config.model.apiKey), config.model.apiKey ? "configured" : "missing"]);
  const lockedTargetOk = !config.model.locked
    || (config.model.name === "deepseek-v4-flash" && config.model.baseUrl.replace(/\/$/, "") === "https://opencode.ai/zen/go/v1");
  checks.push(["model lock", lockedTargetOk, config.model.locked ? `${config.model.name} at ${config.model.baseUrl}` : "unlocked"]);
  checks.push(["constitution", Boolean(config.constitution), config.constitutionSource]);
  try { await access(config.stateDir); checks.push(["state", true, config.stateDir]); }
  catch { checks.push(["state", true, `${config.stateDir} (will be created on first awakening)`]); }
  try {
    const integrity = await verifyStateIntegrity(config.stateDir);
    checks.push(["life integrity", true, integrity.initialized
      ? `${integrity.events} events; identity ${integrity.identityId || "not born"}; snapshot ${integrity.snapshot?.name || "none yet"}`
      : "not initialized yet"]);
  } catch (error) {
    checks.push(["life integrity", false, error.message]);
  }
  if (config.model.apiKey) {
    const providerLabel = config.model.baseUrl.startsWith("https://opencode.ai/zen/go/") ? "OpenCode Go" : "provider catalog";
    try {
      const response = await fetch(`${config.model.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${config.model.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      const ids = (body.data || body.models || []).map((item) => item.id || item.name);
      const selectedAvailable = ids.includes(config.model.name);
      checks.push([providerLabel, response.ok && selectedAvailable, `HTTP ${response.status}; ${config.model.name} ${selectedAvailable ? "available" : "missing"}`]);
    } catch (error) {
      checks.push([providerLabel, false, error.message]);
    }
  }
  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"}  ${name.padEnd(14)} ${detail}`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) {
    process.exitCode = 1;
    console.error(`\n${failed.length} check${failed.length === 1 ? "" : "s"} failed: ${failed.join(", ")}`);
    console.error("Revo will not wake until every check passes. Fix the FAIL lines above and run `revo --doctor` again.");
  }
}

// process.exit() while provider keep-alive sockets are still closing aborts with a
// libuv assertion on Windows (src\\win\\async.c). Hold the entry point open and let
// the event loop drain on its own instead; the guard only fires if something else
// keeps the loop busy forever.
function endProcessGracefully() {
  return new Promise(() => {
    const guard = setTimeout(() => process.exit(process.exitCode || 0), 5_000);
    guard.unref();
  });
}

function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(value || "");
  if (!match) throw new Error("Duration must look like 30s, 20m, or 2h");
  return Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 })[match[2].toLowerCase()];
}

function parsePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}
