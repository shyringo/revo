import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const IGNORED = new Set([".git", ".revo", "node_modules", "coverage"]);

export class WorkspaceSensor {
  #root;
  #snapshot = new Map();
  #initialized = false;

  constructor(root) {
    this.#root = resolve(root);
  }

  async sample() {
    const next = new Map();
    await snapshotRoot(this.#root, next);
    if (!this.#initialized) {
      this.#snapshot = next;
      this.#initialized = true;
      return { kind: "workspace", initialFiles: next.size, changes: [] };
    }
    const changes = [];
    for (const [path, value] of next) {
      const old = this.#snapshot.get(path);
      if (!old) changes.push({ type: "created", path });
      else if (old.mtimeMs !== value.mtimeMs || old.size !== value.size) changes.push({ type: "modified", path });
    }
    for (const path of this.#snapshot.keys()) if (!next.has(path)) changes.push({ type: "removed", path });
    this.#snapshot = next;
    return { kind: "workspace", changes: changes.slice(0, 100), truncated: changes.length > 100 };
  }
}

async function snapshotRoot(root, target) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries.slice(0, 2000)) {
    if (IGNORED.has(entry.name)) continue;
    const full = resolve(root, entry.name);
    try {
      const info = await stat(full);
      target.set(relative(root, full).replaceAll("\\", "/"), {
        kind: entry.isDirectory() ? "directory" : "file",
        mtimeMs: info.mtimeMs,
        size: entry.isFile() ? info.size : 0,
      });
    } catch { /* Entry changed while sampling. */ }
  }
}
