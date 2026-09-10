import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class EventStore {
  #path;
  #events = [];
  #types = new Map();
  #tail = Promise.resolve();
  #listeners = new Set();
  #activePath;
  #failed;

  constructor(path) {
    this.#path = path;
    this.#activePath = path;
  }

  async open() {
    this.#events = [];
    this.#types.clear();
    this.#failed = undefined;
    await mkdir(dirname(this.#path), { recursive: true });
    const directory = dirname(this.#path);
    const base = basename(this.#path, ".jsonl");
    const names = await readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const segments = names.filter((name) => name.startsWith(`${base}.segment-`) && name.endsWith(".jsonl")).sort();
    const paths = [this.#path, ...segments.map((name) => join(directory, name))];
    const ids = new Set();
    let latestExisting = this.#path;
    let latestTorn = false;
    for (const path of paths) {
      let text;
      try { text = await readFile(path, "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      latestExisting = path;
      latestTorn = false;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/\r$/, "");
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); }
        catch (error) {
          const isTornTail = index === lines.length - 1 && !text.endsWith("\n");
          if (!isTornTail) throw new Error(`Invalid event in ${basename(path)} at line ${index + 1}: ${error.message}`);
          latestTorn = true;
          break;
        }
        const expectedSeq = this.#events.length + 1;
        if (event?.seq !== expectedSeq || typeof event.id !== "string" || !event.type || ids.has(event.id)) {
          throw new Error(`Invalid event envelope in ${basename(path)} at line ${index + 1}`);
        }
        ids.add(event.id);
        const frozen = deepFreeze(event);
        this.#events.push(frozen);
        this.#index(frozen);
        if (index === lines.length - 1 && !text.endsWith("\n")) latestTorn = true;
      }
    }
    this.#activePath = latestTorn ? this.#newSegmentPath() : latestExisting;
    return this;
  }

  append(type, data = {}, meta = {}) {
    return this.#append(type, data, meta);
  }

  appendIf(type, data, predicate, meta = {}) {
    if (typeof predicate !== "function") throw new TypeError("appendIf requires a predicate");
    return this.#append(type, data, meta, predicate);
  }

  #append(type, data, meta, predicate) {
    const operation = this.#tail.then(async () => {
      if (this.#failed) throw this.#failed;
      if (predicate && !predicate(this.#events)) return null;
      let encoded;
      try {
        encoded = JSON.stringify({
          id: randomUUID(),
          seq: this.#events.length + 1,
          at: new Date().toISOString(),
          type,
          data,
          meta,
        });
      } catch (error) {
        error.eventStoreInputRejected = true;
        throw error;
      }
      if (encoded === undefined) {
        const error = new Error("Event is not JSON-serializable");
        error.eventStoreInputRejected = true;
        throw error;
      }
      const event = deepFreeze(JSON.parse(encoded));
      const file = await open(this.#activePath, "a");
      try {
        const line = `${encoded}\n`;
        const written = await file.write(line);
        if (written.bytesWritten !== Buffer.byteLength(line)) throw new Error("Partial event-log write");
        await file.sync();
      } finally {
        await file.close();
      }
      this.#events.push(event);
      this.#index(event);
      for (const listener of [...this.#listeners]) {
        try { Promise.resolve(listener(event)).catch(() => {}); }
        catch { /* Durable append observers cannot roll back committed facts. */ }
      }
      return event;
    });
    this.#tail = operation.then(() => undefined, (error) => {
      if (!error.eventStoreInputRejected) this.#failed = error;
    });
    return operation;
  }

  all() {
    return [...this.#events];
  }

  since(seq = 0) {
    return this.#events.filter((event) => event.seq > seq);
  }

  byType(...types) {
    if (types.length === 1) return [...(this.#types.get(types[0]) || [])];
    return types.flatMap((type) => this.#types.get(type) || []).sort((a, b) => a.seq - b.seq);
  }

  async flush() {
    await this.#tail;
    if (this.#failed) throw this.#failed;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async checkpoint(directory) {
    await this.flush();
    await mkdir(directory, { recursive: true });
    const last = this.#events.at(-1);
    if (!last) return null;
    const stamp = last.at.replace(/[:.]/g, "-");
    const name = `${basename(this.#path, ".jsonl")}-${String(last.seq).padStart(10, "0")}-${stamp}.jsonl`;
    const target = join(directory, name);
    const content = this.#events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    const bytes = await readFile(target);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(`${target}.sha256`, `${sha256}  ${name}\n`, { encoding: "utf8", flag: "wx" });
    return { path: target, sha256, bytes: bytes.length, throughSeq: last.seq };
  }

  #index(event) {
    const entries = this.#types.get(event.type);
    if (entries) entries.push(event);
    else this.#types.set(event.type, [event]);
  }

  #newSegmentPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const nextSeq = String(this.#events.length + 1).padStart(10, "0");
    return join(dirname(this.#path), `${basename(this.#path, ".jsonl")}.segment-${nextSeq}-${stamp}-${randomUUID()}.jsonl`);
  }
}

function deepFreeze(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current)) if (child && typeof child === "object") pending.push(child);
  }
  return value;
}
