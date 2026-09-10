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
