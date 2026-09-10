# Life Architecture

## One Life, Many Awakenings

Revo has one durable identity and many awake periods. Its first awakening appends one `identity.born` fact with a stable UUID; later awakenings inherit it. Starting the process wakes Revo, and graceful exit puts it to sleep. Sleep has no model calls, observation, communication, or background process pretending to be conscious.

The life stream carries an explicit `life.format` version. Missing pre-version logs are upgraded by appending the current version without rewriting old facts; unknown future versions fail closed until a real migration exists.

A state-directory-derived loopback life lock prevents two local processes from waking the same identity concurrently. The operating system releases the lock on normal exit or crash, so recovery requires no stale lock-file deletion. Multi-machine shared-state locking is not implemented in v0.

```text
ASLEEP -> WAKING -> OBSERVING -> THINKING -> ACTING -> VERIFYING
                        ^                              |
                        +--------- next cycle <-------+
                                      |
                              FALLING ASLEEP -> ASLEEP
```

While awake, only the owner or a preconfigured hard time/token limit may initiate sleep. An empty message queue is never a stopping condition.

## Self-Seeding Life Loop

The life loop owns cognition. External tasks do not own the loop.

1. Claim user, recovery, and environmental signals. If none exist, create an endogenous continuation signal from current attention.
2. Observe the workspace and record material changes.
3. Compact the uncheckpointed model-visible surface when provider-reported or conservatively estimated token pressure reaches the economic threshold. A high event-count ceiling is only a safety backstop.
4. Assemble current awareness from self-state, active intentions, relevant durable memory, the previous sleep capsule, compacted history, recent events, usage, and fresh observations.
5. Invoke the real model and execute its tool calls for a bounded number of steps.
6. Persist messages, tool outcomes, memories, intentions, and self-state updates.
7. Immediately begin the next cycle. There is no timer, heartbeat, rest, or wait for human input.

User input takes a smaller interaction lane first: the same configured model receives recent dialogue and current attention without tool schemas, returns a direct response with a 256-token ceiling, and then continuous autonomous cognition resumes. This prevents a simple conversation from waiting behind environment planning.

All cognition uses the configured `deepseek-v4-flash`. Direct interaction, compaction, and sleep consolidation request its non-thinking mode for latency and cost; autonomous cognition requests high reasoning. The provider may normalize or partially ignore these controls, so Revo accounts from returned usage rather than assuming savings. This allocates productive capacity by task value without switching models.

Human priority has two independent settlements. `replyToSeq` closes the immediate response wait; it does not complete the underlying instruction. Every `user.message` remains an active human obligation until a durable `human.input.resolved` event records that direct conversation fully satisfied it, requested work was actually completed (with a delivery for substantial work), or a later instruction superseded it. Pending replies and obligations are reconstructed after restart.

Communication has a separate direction. Ordinary autonomous model text is a LIFE reflection, not speech addressed to the human. `speak_to_user` creates a durable `proactive.message` only when the model provides both useful substance and a why-now rationale under one of five attention-worthy categories: discovery, question, milestone, risk, or decision. The tool enforces duplicate suppression, a cross-restart minimum interval, and an hourly attention budget. Proactive speech never resolves a human obligation. A later `user.message` counts as response for the CHAT badge while becoming its own durable human input.

Independent objectives can branch into the internal workgraph. Work cells are concurrent bounded model calls, not agents or sessions: they have no persona, private memory, user channel, or tool authority. Dependency edges control readiness; results and usage commit to the shared life. Human input globally interrupts all running cells before the direct interaction lane, and stale racing cell outputs are never adopted. See [Workgraph](workgraph.md).

Revo carries a durable `cognitive-thrift` identity principle. Autonomous cognition favors progressive observation, small result windows, batched independent checks, and reuse of stable knowledge. Tool defaults are deliberately bounded, but the model can request larger ranges when a high-value uncertainty justifies the cost.

Continuous cognition is not random exploration. Attention must trace a legible chain from Constitution or an outstanding human instruction, through durable intention, to the current information gap and next action. `update_self_state` records that rationale so a ten-year life remains auditable and lower-level goals can be revised without silently changing the Constitution.

DeepSeek V4 Flash has a 1,048,576-token context window, but Revo defaults to compaction at 120,000 tokens to control recurring input cost. Before that boundary, all uncheckpointed model-visible facts remain in awareness; they are not silently hidden by an arbitrary recent-event slice. Successful iterative summaries carry the previous summary forward and retain a recent tail. Failed or cancelled compaction advances no checkpoint.

API requests are discrete, but causally linked state makes them one continuing cognitive process. New user input aborts a stale request or approval wait and rebuilds awareness from durable facts. Completed external effects remain recorded.

## Sleep and Wake

Graceful sleep reserves a final model call that produces a continuity capsule containing verified learning, active intentions, open questions, uncertain external effects, and facts requiring revalidation. The next awakening inherits the capsule but observes the real environment before trusting it.

If a crash leaves `life.awoke` without `life.slept` or `life.forced_sleep`, the next awakening records recovery and treats in-flight effects as uncertain. It does not replay an instruction blindly. A second `Ctrl+C` records explicit forced sleep: it closes the awake lifecycle without claiming that consolidation or a snapshot completed.

Every model request and executable tool effect first commits a durable intent. A model intent left open by a crash is recorded as unknown billing/outcome and then abandoned; its unknown output is never adopted. A tool intent left open may already have changed the world, remains an active `U` condition, and must be reconciled from external evidence with `resolve_unknown_effect` before it clears.

Approvals never cross interruption, sleep, or crash. Each request settles as `approval.decided` or `approval.expired`; startup expires any previously unclosed request and never reconstructs it as permission.

## State Lifetime

| State | Crosses sleep | Rule |
| --- | --- | --- |
| Identity and principles | Yes | Versioned durable state |
| Verified world knowledge | Yes | Keep provenance, confidence, and verification time |
| User commitments and preferences | Yes | Durable until revised or fulfilled |
| Proactive messages and their rationale | Yes | Persist as relationship events; never masquerade as direct replies |
| Intentions and open questions | Yes | Revalidate on wake |
| Conclusions and lessons | Yes | Promote selectively to semantic memory |
| Raw context window | No | Reconstruct bounded awareness instead |
| Hidden chain-of-thought | No | Persist outcomes and evidence, not private reasoning traces |
| Attention and hypotheses | Conditionally | Promote only when useful; never inherit guesses as facts |
| Tool handles, locks, approvals | No | Expire at sleep; verify external effects after interruption |
| TUI input and rendering state | No | Interface-only state |

## Durable Source of Truth

`EventStore` writes `<workspace>/.revo/life.jsonl`, one JSON object per line with monotonic sequence numbers and an `fsync` after every append. Context compaction appends a checkpoint and never removes original evidence. Memory, intentions, self-state, recovery, and sleep continuity are projections over the same history.

Events become visible to projections only after their append and `fsync` succeed. Data is JSON-materialized and deeply frozen before commit, so later caller mutation cannot rewrite history. Failed serialization consumes no sequence number.

If power loss leaves only the final physical JSONL line torn, Revo preserves that byte fragment, seals the file, and continues in a new ordered `life.segment-*` file; no truncation or deletion is used. Complete malformed lines, duplicate ids, or non-monotonic sequences remain hard integrity failures. Sleep snapshots reconstruct all verified segments into one checksummed JSONL.

Post-commit observers are failure-contained: a TUI or plugin observer cannot roll back or fail an already durable append. The TUI builds incremental CHAT/LIFE/DELIVERIES projections from this feed instead of copying the complete event history on every refresh. Tool results remain compact by default and expand in place with `Ctrl+O`, following pi's principle that evidence must be available without permanently dominating the transcript.

The in-memory store maintains an incremental type index, so Constitution, identity, memory, obligation, and delivery projections do not repeatedly scan unrelated life events. v0 still loads the complete JSONL and renders historical TUI content from memory; multi-year segmented storage, indexed disk queries, and paged transcript rendering remain required before claiming ten-year operational scale.

After every graceful `life.slept` and durability flush, Revo creates a non-overwriting full JSONL snapshot plus SHA-256 checksum under `stateDir/snapshots`. Forced termination creates no snapshot. v0 does not prune snapshots automatically, because retention must not silently erase life history.

## Cost Boundary

Cost is controlled by an awake-period boundary, never by silently disabling cognition:

- `--for 30m` installs an independent hard timer that can interrupt model, tool, or approval waits.
- `--token-budget 200000` ends cognition after the first response that reaches the limit.
- Per-request timeouts and per-cycle tool-step bounds prevent one cycle from monopolizing a life.
- Token use and model-call count remain visible in the TUI.

The final sleep capsule may consume a small amount beyond the nominal limit. That is deliberate continuity overhead.

An already durable human message is answered before token-budget sleep, even if a racing stale autonomous response reached the limit; the budget then prevents further autonomous work. The explicit awake-time timer remains a hard cutoff and may interrupt any phase.

## Capability Boundaries

The microkernel owns service registration and reversible plugin lifecycle. The life loop consumes replaceable model, event store, memory, tool, approval, and sensor services. The TUI observes durable events and runtime status but does not drive cognition.

`plugins` in the private config may name explicit local ES modules. Each exports a named `mount(kernel)` plugin and may register tools, services, or event observers; disposers unwind in reverse mount order on sleep. Revo does not auto-discover or download executable plugins.

A future DeepSeek Harness integration should replace its queued-prompt agent loop with this self-seeding life loop. Wrapping DSH with a timer would not implement Revo's contract.
