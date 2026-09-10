import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel } from "../src/core/kernel.js";
import { loadPlugins } from "../src/core/plugin-loader.js";

test("configured plugins mount through the kernel and dispose in reverse lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revo-plugin-"));
  const path = join(directory, "plugin.mjs");
  await writeFile(path, `export default { name: "fixture", mount(kernel) { kernel.provide("fixture", 42); return () => globalThis.__revoPluginDisposed = true; } };`);
  const kernel = new Kernel();
  await loadPlugins(kernel, ["plugin.mjs"], directory);
  assert.equal(kernel.service("fixture"), 42);
  await kernel.close();
  assert.equal(globalThis.__revoPluginDisposed, true);
  globalThis.__revoPluginDisposed = undefined;
});
