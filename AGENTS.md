# Revo Engineering Agreements

Read `docs/vision.md`, `docs/life.md`, `docs/constitution.md`, and `docs/upstream-analysis.md` before changing runtime behavior.

## Non-negotiable Invariants

- While awake, a real model continuously drives a self-seeding life loop. Do not add heartbeat, rest, empty-queue termination, or a model-free "alive" state.
- Human input is durable priority work. It preempts autonomous cognition, receives a direct streamed reply, and remains an obligation until explicitly resolved.
- Proactive speech must earn human attention through `speak_to_user`; ordinary autonomous narration stays in LIFE, and outreach never resolves human obligations.
- Revo is one subject with one human entrance. Internal work cells are non-personal bounded computations, never user-visible sessions, personas, independent memories, or voices.
- Human input preempts foreground cognition and every running work cell; stale racing outputs are accounted but never adopted.
- CHAT, LIFE, and DELIVERIES are separate projections of one append-only life stream.
- The effective Constitution is versioned into life history and present in every model request.
- Persist intent before provider or tool effects. Unknown crash-time tool effects require evidence-based reconciliation and are never blindly replayed.
- Compaction changes model-visible context without deleting original evidence. Failed or cancelled compaction advances no checkpoint.
- Keep credentials, private configuration, life logs, snapshots, generated transcripts, and upstream checkouts outside Git and npm packages.
- This installation is locked to OpenCode Go `deepseek-v4-flash`; tests must never require paid inference.

## Change Discipline

- Use Node.js standard-library APIs unless a dependency removes substantial, proven complexity.
- Preserve Windows and Linux behavior; run `npm run check` and keep CI green on Node.js 22/24.
- Add tests for lifecycle, durability, cancellation, effects, context projection, terminal layout, and package boundaries in proportion to the change.
- Do not copy upstream pi or DeepSeek Harness code. Record adopted ideas and exact source commits in provenance/source-analysis documentation.
- Do not delete or overwrite existing user data, state, history, assets, or files without explicit confirmation for that deletion.
