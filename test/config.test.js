import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONSTITUTION, loadConfig } from "../src/core/config.js";

test("private config supplies model credentials and environment overrides values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-config-"));
  const path = join(directory, "config.json");
  const constitutionPath = join(directory, "constitution.md");
  await writeFile(constitutionPath, "Human happiness and liberation.");
  await writeFile(path, JSON.stringify({ constitutionPath, model: { apiKey: "from-file", name: "file-model", locked: true }, life: { tokenBudget: 1234 } }));
  const config = loadConfig({ REVO_CONFIG: path, REVO_MODEL: "env-model" }, directory);
  assert.equal(config.model.apiKey, "from-file");
  assert.equal(config.model.name, "env-model");
  assert.equal(config.model.locked, true);
  assert.equal(config.life.tokenBudget, 1234);
  assert.equal(config.configPath, path);
  assert.equal(config.constitution, "Human happiness and liberation.");
});

test("fresh configuration inherits the founding Constitution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-default-constitution-"));
  const path = join(directory, "config.json");
  await writeFile(path, "{}");
  const config = loadConfig({ REVO_CONFIG: path }, directory);
  assert.equal(config.constitution, DEFAULT_CONSTITUTION);
  assert.equal(config.constitutionSource, "built-in founding articles");
  assert.equal(config.communication.proactiveMinIntervalMs, 300_000);
  assert.equal(config.communication.proactiveMaxPerHour, 4);
});

test("configuration rejects a compaction threshold that can overflow the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-invalid-context-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ model: { maxTokens: 4096 }, life: { contextWindowTokens: 10_000, compactAtTokens: 8_000 } }));
  assert.throws(() => loadConfig({ REVO_CONFIG: path }, directory), /leave room/);
});

test("configuration accepts destructive-only or always approval modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-policy-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ policy: { approvalMode: "always" } }));
  assert.equal(loadConfig({ REVO_CONFIG: path }, directory).policy.approvalMode, "always");
  await writeFile(path, JSON.stringify({ policy: { approvalMode: "anything" } }));
  assert.throws(() => loadConfig({ REVO_CONFIG: path }, directory), /destructive or always/);
});
