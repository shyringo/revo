import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSensor } from "../src/sensors/workspace.js";

test("workspace sensor wakes from a bounded root snapshot instead of crawling the tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "revo-sensor-"));
  await mkdir(join(root, "deep", "nested"), { recursive: true });
  await writeFile(join(root, "visible.txt"), "one");
  await writeFile(join(root, "deep", "nested", "hidden.txt"), "two");
  const sensor = new WorkspaceSensor(root);
  const initial = await sensor.sample();
  assert.equal(initial.initialFiles, 2, "one root file and one root directory");
  await writeFile(join(root, "new.txt"), "three");
  const changed = await sensor.sample();
  assert.ok(changed.changes.some((item) => item.type === "created" && item.path === "new.txt"));
});
