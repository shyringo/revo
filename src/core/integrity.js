import { access, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EventStore } from "./event-store.js";

export async function verifyStateIntegrity(stateDir) {
  const lifePath = join(stateDir, "life.jsonl");
  try { await access(lifePath); }
  catch { return { initialized: false, events: 0, identityId: null, snapshot: null }; }

  const store = await new EventStore(lifePath).open();
  const identities = store.byType("identity.born");
  if (identities.length > 1) throw new Error(`Life log contains ${identities.length} birth identities`);

  const snapshotsDir = join(stateDir, "snapshots");
  let snapshot = null;
  try {
    const files = (await readdir(snapshotsDir)).filter((name) => name.endsWith(".jsonl")).sort();
    const latest = files.at(-1);
    if (latest) {
      const path = join(snapshotsDir, latest);
      const bytes = await readFile(path);
      const checksum = (await readFile(`${path}.sha256`, "utf8")).trim().split(/\s+/, 1)[0].toLowerCase();
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== actual) throw new Error(`Snapshot checksum mismatch: ${latest}`);
      const replay = await new EventStore(path).open();
      snapshot = { name: latest, sha256: actual, events: replay.all().length };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return {
    initialized: true,
    events: store.all().length,
    identityId: identities[0]?.data.id || null,
    snapshot,
  };
}
