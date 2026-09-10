# Source Analysis: pi and DeepSeek Harness

This analysis is pinned to source, not project descriptions:

- [pi commit `4e494929`](https://github.com/badlogic/pi-mono/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee)
- [DeepSeek Harness commit `cd5ef814`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)

The criterion is not feature count. A harness defines the production relations around model capability: what the model can perceive, what survives, who can interrupt, how actions become reality, and how work is delivered and governed.

## pi

### Strong mechanisms

- [`agent-loop.ts`](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts) cleanly separates the low-level loop from its stateful wrapper. `transformContext`, `prepareNextTurn`, `shouldStopAfterTurn`, steering, and follow-up are explicit boundaries rather than prompt conventions.
- Streaming has a linear `message_start -> message_update* -> message_end` lifecycle. Delta events avoid repeatedly emitting the cumulative message, preventing quadratic UI traffic.
- Steering is consumed before the next assistant response; follow-up is consumed only when the loop would otherwise stop. This is a useful distinction between interruption and deferred work.
- Tool calls default to parallel execution while tools may declare sequential mode. Results are presented in model order.
- A response stopped by output length cannot execute its possibly truncated tool arguments.
- [`ScrollView`](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/components/scroll-view.ts) distinguishes follow-end from explicit manual position. Appends preserve manual reading position until the user returns to the end.
- Compaction combines provider-reported usage with estimates only for trailing messages, retains a recent tail, and carries cumulative file-operation facts across summaries.
- The newer [`AgentHarness`](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/harness/agent-harness.ts) and its pure [`reducer`](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/harness/reducer.ts) go beyond the classic loop: lanes persist intent before effects, queue and pending-write identities, usage ledger rows, suspended operations, retry state, and bounded contradiction checks for crash recovery. This layer is still visibly evolving, but its intent/effect discipline is highly relevant to long-lived Revo.

### Adopted in Revo

- Direct use of `@earendil-works/pi-tui` for its Editor, CJK/IME cursor handling, bracketed paste, history, completion, differential alternate-screen rendering, search, and follow-end/manual-scroll separation.
- A pi-shaped coding baseline named `read`, `write`, `edit`, and `bash`; Revo keeps its own durable intent/effect wrapper and adds `ls`/`grep` rather than importing pi's task-owned agent loop.
- Compact-by-default tool presentation with explicit `Ctrl+O` evidence expansion, adapted to a potentially lifelong transcript.
- Separate immediate human interaction from deferred autonomous continuation.
- Bounded tool results and explicit sequential side-effect boundaries.
- The principle that stream updates and final durable messages are different artifacts.
- Persist intent before external effects and treat crash-time outcomes as unknown until reconciled, rather than blindly replaying them.

### Not adopted

pi's loop ends when tool calls, steering, and follow-up queues are empty. That is correct for a task-owned run but contradicts Revo's awake contract. Revo creates an endogenous continuation instead.

## DeepSeek Harness

### Strong mechanisms

- [`agent/inbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent/src/inbox.ts) is a replayable projection over durable splice events. `next-step` and `next-turn` work survive restart and have explicit claim/cancel identities.
- [`agent-loop/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent-loop/src/agent.ts) models idle, maintenance, and running phases, latches wakeups across cancellation races, brackets every turn/step durably, and closes failures in `finally`.
- [`tool-calls.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent-loop/src/tool-calls.ts) runs safe groups concurrently under a pool limit but advances durable commits only across contiguous model-order slots. Sequential tools form barriers.
- The session service commits append-only immutable facts before notifying observers. Model-visible history is a derived surface, so compaction can replace context without rewriting evidence.
- [`compaction-basic`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/compaction/compaction-basic/src/index.ts) uses routed-model token capacity, performs model-free tool-result pruning before LLM summarization, retries overflow only after durable surface progress, and runs manual compaction behind a maintenance reservation.
- Cordis scopes make registrations reversible and allow per-agent tool visibility/restrictions without changing global siblings.

### Adopted in Revo

- Append-only life facts with separate UI/model projections.
- Structured cancellation and stale-result rejection before human interaction.
- Internal state hidden behind services instead of exposed as workspace files.
- Durable deliveries as their own projection, analogous to keeping human records separate from model-visible replacements.
- Parallel execution for consecutive read-only tools with durable results committed in model order; mutations and approvals remain barriers.

### Planned adaptations

- Replace the in-memory signal array with a durable, replayable priority inbox.
- Introduce a singleton token meter and prune stale tool results before invoking summary compaction.
- Add provider streaming so CHAT shows useful deltas without weakening final-message durability.
- Replace Revo's minimal service registry with genuinely scoped, reversible capability composition.

### Not adopted

DSH's driver becomes idle when its inbox empties. Revo can reuse the inbox, session, tool scheduler, and compaction relations, but its driver must self-seed another cognitive cycle while awake. A timer that periodically sends another prompt would preserve DSH's task relation and would not implement Revo.

## Decision

Revo remains an original life loop rather than a thin wrapper. Near-term work should selectively port invariants, not code: durable priority admission, ordered effects, streaming projections, exact token accounting, and reversible scopes. The defining difference remains who owns time: a queued task in pi/DSH, or the continuing subject in Revo.
