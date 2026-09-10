# Provenance and Original Work

Revo's continuous-life runtime is original code. Its terminal layer directly depends on pi's separately published MIT-licensed TUI library rather than reimplementing mature terminal mechanics.

## Reused Code and Data

- `@earendil-works/pi-tui` 0.84.3 (MIT): alternate-screen differential rendering, scroll views, editor, CJK/IME cursor handling, history, paste handling, completion, and terminal input normalization. The local source review was pinned to pi commit `4e494929998d6bc4fccf75e0a233f727db4b70ee`.
- Revo's MIT license covers this repository's code; dependency licenses remain their own.

## Adapted Public Ideas

- [pi](https://github.com/badlogic/pi-mono): a deliberately small coding-agent core, JSONL session persistence, extension hooks, and structured automatic compaction informed Revo's preference for a compact implementation and inspectable state.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): Cordis-style reversible services, an append-only session log, replaceable agent loops, and capability seams informed Revo's plugin boundaries. Revo does not depend on or wrap DSH.

## Project-Specific Design

- **Awake Contract**: while the process claims to be awake, a real model continuously drives cognition. There is no model-free alive state.
- **Self-Seeding Life Loop**: every completed cognitive cycle directly creates the endogenous continuation for the next; no prompt, timer, heartbeat, or queued task owns the loop.
- **One Life, Many Awakenings**: process runs are awake periods connected by deliberate sleep capsules, recovery checks, durable identity, memory, and commitments.
- **Unified Life Stream**: conversation, autonomous work, environmental observation, self-state, and deferred intention are prioritized stimuli entering the same durable history.
- **Separated Life Projections**: CHAT, LIFE, and DELIVERIES remain distinct human interfaces over one event stream, so subjective continuity does not erase discoverability or formal delivery.
- **Durable Human Priority**: human input is reconstructed as unanswered work after restart and settled only by an explicitly correlated direct response.
- **Attention-Budgeted Outreach**: Revo may initiate communication through a distinct durable action with why-now rationale, semantic categories, duplicate suppression, cooldown, and hourly limits; autonomous narration remains separate.
- **Subject-Preserving Workgraph**: internal parallelism branches into non-personal dependency cells while identity, memory, authority, commitments, and the human entrance remain singular.
- **Constitutional Attention**: autonomous work must trace a rationale from Constitution or human instruction through intention and information gap, preventing unbounded life from degrading into random exploration.
- **Owner-Controlled Sleep**: only the owner or an explicit hard life budget ends an awake period; the model cannot treat lack of work as permission to rest.
- **Interruptible Awareness**: new human input aborts stale model work or pending approval and rebuilds the next awareness envelope from durable facts.
- **Awareness Envelope**: each cycle receives a bounded reconstruction of current signals, observations, self-state, intentions, retrieved long-term memory, prior sleep continuity, compacted history, and recent events.
- **Non-destructive Compaction**: summaries change the model-visible surface without rewriting the source event log.

These are original to this implementation as a combined architecture. Individual ingredients such as event sourcing, preemption, retrieval, scheduling, and compaction are established techniques; Revo does not claim to have invented them independently.
