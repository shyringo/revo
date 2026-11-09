import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const cli = join(process.cwd(), "src", "cli.js");

test("help and version work even when configured state is broken", async () => {
  const env = { ...process.env, REVO_CONFIG: join(process.cwd(), "missing-config.json") };
  const help = await execFileAsync(process.execPath, [cli, "--help"], { env });
  assert.match(help.stdout, /Revo stays continuously awake/);
  const version = await execFileAsync(process.execPath, [cli, "--version"], { env });
  assert.equal(version.stdout.trim(), "0.1.0");
});

// --- M146: a missing credential or a missing terminal must never surface as a bare stack ---

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const sandboxHome = mkdtempSync(join(tmpdir(), "revo-cli-"));

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ["REVO_CONFIG", "REVO_API_KEY", "REVO_STATE_DIR", "REVO_WORKSPACE", "REVO_BASE_URL", "REVO_MODEL", "REVO_CONSTITUTION"]) delete env[key];
  return { ...env, HOME: sandboxHome, USERPROFILE: sandboxHome, ...extra };
}

function sandboxConfig(name, value) {
  const path = join(sandboxHome, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function runCli(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { env, timeout: 30_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

test("without a credential Revo says NO MIND with the next step instead of crashing", async () => {
  const { code, stderr } = await runCli(["--for", "5s"], isolatedEnv());
  assert.equal(code, 1);
  assert.match(stderr, /NO MIND/);
  assert.match(stderr, /REVO_API_KEY/);
  assert.match(stderr, /revo --doctor/);
  assert.doesNotMatch(stderr, /node:internal/);
  assert.doesNotMatch(stderr, /ERR_INVALID_ARG_TYPE/);
});

test("with a credential but no interactive terminal Revo exits with a readable hint", async () => {
  const configPath = sandboxConfig("terminal-config.json", {
    stateDir: join(sandboxHome, "terminal-state"),
    model: { apiKey: "sk-not-a-real-key", baseUrl: "http://127.0.0.1:9/v1", name: "sandbox-model", timeoutMs: 1_000, maxTokens: 256 },
  });
  const { code, stderr } = await runCli(["--for", "5s"], isolatedEnv({ REVO_CONFIG: configPath }));
  assert.equal(code, 1);
  assert.match(stderr, /NO SCREEN/);
  assert.match(stderr, /interactive terminal/);
  assert.match(stderr, /revo --status/);
  assert.doesNotMatch(stderr, /node:internal/);
});

test("a failing doctor run reports the failed check and exits cleanly", async () => {
  const configPath = sandboxConfig("doctor-config.json", {
    stateDir: join(sandboxHome, "doctor-state"),
    model: { apiKey: "sk-not-a-real-key", baseUrl: "http://127.0.0.1:9/v1", name: "sandbox-model", timeoutMs: 1_000, maxTokens: 256 },
  });
  const { code, stdout, stderr } = await runCli(["--doctor"], isolatedEnv({ REVO_CONFIG: configPath }));
  assert.equal(code, 1);
  assert.match(stdout, /^FAIL\s/m);
  assert.match(stderr, /check failed/);
  assert.match(stderr, /revo --doctor/);
  assert.doesNotMatch(stderr, /Assertion failed/);
});
