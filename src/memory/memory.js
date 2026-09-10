import { randomUUID } from "node:crypto";

const WORD = /[a-z0-9_-]{2,}/gi;
const CJK = /[\u3400-\u9fff]+/gu;

export class Memory {
  constructor(store) {
    this.store = store;
  }

  async remember(text, kind = "semantic", salience = 0.5, source = "agent") {
    const normalized = normalize(text);
    const existing = this.store.byType("memory.remembered").findLast((event) => normalize(event.data.text) === normalized);
    if (existing) {
      await this.store.append("memory.reinforced", { memoryId: existing.data.id || existing.id, salience: clamp(salience), source });
      return { ...existing.data, id: existing.data.id || existing.id, reinforced: true };
    }
    const memory = { id: randomUUID(), text: String(text).trim(), kind, salience: clamp(salience), source };
    if (!memory.text) throw new Error("Memory text cannot be empty");
    await this.store.append("memory.remembered", memory);
    return memory;
  }

  retrieve(query, limit = 8) {
    const queryWords = words(query);
    const reinforcements = new Map();
    for (const event of this.store.byType("memory.reinforced")) {
      reinforcements.set(event.data.memoryId, (reinforcements.get(event.data.memoryId) || 0) + 1);
    }
    return this.store.byType("memory.remembered")
      .map((event) => {
        const id = event.data.id || event.id;
        return { ...event.data, id, at: event.at, score: score(event.data, queryWords) + Math.log2(1 + (reinforcements.get(id) || 0)) * 0.25 };
      })
      .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  latestCompaction() {
    return this.store.byType("context.compacted").at(-1) || null;
  }

  surfaceEvents(recentLimit = 40) {
    const all = this.store.all();
    const compacted = this.latestCompaction();
    const tail = compacted ? all.filter((event) => event.seq > compacted.data.throughSeq) : all;
    return Number.isFinite(recentLimit) ? tail.slice(-recentLimit) : tail;
  }

  async compact(model, events, signal) {
    if (events.length < 8) return null;
    const lastFailure = this.store.byType("context.compaction_failed").at(-1);
    if (lastFailure && events.at(-1).seq - lastFailure.seq < 10) return null;
    const throughSeq = events.at(-Math.max(5, Math.floor(events.length * 0.25)))?.seq;
    const selected = events.filter((event) => event.seq <= throughSeq);
    if (!selected.length) return null;
    const previous = this.latestCompaction()?.data.summary || "(none)";
    const pruned = selected.map(renderCompactionEvent).filter(Boolean).join("\n");
    await this.store.append("context.compaction_started", { throughSeq, eventCount: selected.length });
    const modelIntent = await this.store.append("model.intent", { lane: "compaction", throughSeq });
    try {
      let response;
      try {
        response = await model.complete({
          messages: [
            { role: "system", content: "Compress this durable agent history. Preserve the previous summary, Constitution-relevant learning, human commitments, unresolved intentions, deliveries, decisions, evidence, failures, file changes, and next actions. Omit lifecycle chatter. Return concise Markdown." },
            { role: "user", content: `# Previous summary\n${previous}\n\n# New durable facts\n${pruned}` },
          ],
          maxTokens: 1024,
          thinking: false,
          signal,
        });
      } catch (error) {
        await this.store.append("model.failed", { lane: "compaction", intentId: modelIntent.id, throughSeq, error: error.message });
        throw error;
      }
      const summary = response.content.trim();
      await this.store.append("model.completed", { lane: "compaction", intentId: modelIntent.id, throughSeq, stale: Boolean(signal?.aborted), usage: response.usage, toolCalls: [] });
      signal?.throwIfAborted();
      if (!summary) throw new Error("Compaction returned an empty summary");
      const data = { throughSeq, eventCount: selected.length, summary, usage: response.usage };
      await this.store.append("context.compacted", data);
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.store.append("context.compaction_failed", { throughSeq, eventCount: selected.length, error: error.message });
      return null;
    }
  }
}

export function renderEvent(event) {
  return `[${event.seq} ${event.at} ${event.type}] ${JSON.stringify(event.data)}`;
}

export function estimateEventTokens(events) {
  let chars = 0;
  for (const event of events) chars += renderCompactionEvent(event)?.length || 0;
  return Math.ceil(chars / 3);
}

function words(text) {
  const value = String(text).toLowerCase();
  const terms = new Set(value.match(WORD) || []);
  for (const sequence of value.match(CJK) || []) {
    const chars = [...sequence];
    if (chars.length === 1) terms.add(chars[0]);
    for (let index = 0; index < chars.length - 1; index++) terms.add(chars[index] + chars[index + 1]);
  }
  return terms;
}

function normalize(text) {
  return String(text).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function score(memory, queryWords) {
  const haystack = words(memory.text);
  let overlap = 0;
  for (const word of queryWords) if (haystack.has(word)) overlap += 1;
  return overlap * 2 + Number(memory.salience || 0);
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function renderCompactionEvent(event) {
  if (["cycle.started", "cycle.completed", "model.completed", "context.compaction_started", "context.compaction_failed", "context.compacted"].includes(event.type)) return null;
  if (["tool.completed", "tool.failed", "tool.denied"].includes(event.type)) {
    const data = { ...event.data, result: pruneToolResult(event.data.result) };
    return `[${event.seq} ${event.at} ${event.type}] ${JSON.stringify(data)}`;
  }
  return renderEvent(event);
}

function pruneToolResult(result) {
  const text = JSON.stringify(result);
  if (text.length <= 2_000) return result;
  return { pruned: true, prefix: text.slice(0, 2_000), originalChars: text.length };
}
