# One Agent, Many Parallel Processes

Revo exposes one continuous human relationship, not a collection of sessions. Internal parallelism is represented as a durable work graph whose nodes are **work cells**, not sub-agents.

## Why the Unit Is Not an Agent

A work cell has no name, persona, conversation, private long-term memory, Constitution, or authority to address the human. It is a bounded computation belonging to Revo. Its complete identity is:

```text
objective + dependency edges + bounded context + token budget + state + output evidence
```

Calling these nodes agents would import an accidental human-organizational metaphor: separate subjects exchange lossy messages, negotiate roles, duplicate context, and require a manager to reconstruct a unified commitment. Revo instead keeps identity, responsibility, memory, authority, and communication singular while allowing computation to branch.

## The Main Agent Comes First

The main Revo is not the foreground LLM call. It is the durable closure over identity, Constitution, human relationship, commitments, memory, world state, resource ownership, causal history, and authority to make external effects. Foreground and parallel model calls are cognitive processes inside that closure.

Consequently, "cell or sub-agent" is not an intrinsic type question. The general primitive is a **process contract** whose relationship to Revo can vary along independent dimensions:

| Dimension | Cell profile now | More agent-like future process |
| --- | --- | --- |
| Objective | One bounded question | A revisable local objective |
| Context | Explicit small projection | Subscribed shared-state view |
| Duration | One model completion | Multiple supervised turns |
| Memory | Result only | Leased local scratch memory |
| Tools | None | Capability-scoped tool leases |
| Decomposition | Cannot reproduce | May propose, not self-admit, child work |
| Communication | Structured return to Revo | Structured events, never a human session |
| Authority | No external effects | Explicit revocable leases only |

Revo should choose this contract end to end from the problem structure. A quick independent comparison should remain a cell. A long investigation needing local adaptation may receive a multi-turn lease and become operationally agent-like. The harness does not force every branch into one class; it enforces the relations that preserve one subject.

Some powers are never delegated: constitutional interpretation, final human commitments, durable identity, unrestricted long-term memory, the sole human entrance, global budget ownership, and the right to admit unlimited further work. These are not implementation conveniences but the boundary that makes all processes parts of Revo rather than separate agents.

## Workgraph Semantics

`open_work_cell` appends a durable node. A node becomes runnable when all dependency nodes have completed. Up to `REVO_WORKGRAPH_CONCURRENCY` cells invoke the same configured model concurrently. Each request receives a small objective-specific context, completed dependency outputs, and Revo's Constitution.

Admission is finite even when the model can imagine unlimited branches. `REVO_WORKGRAPH_MAX_OUTSTANDING` bounds all admitted unfinished cells, not merely active calls. When capacity is reached, the harness returns the current work debt and refuses the new commitment; Revo must integrate, finish, revise, or cancel existing work before expanding again. Decomposition cannot manufacture capacity or escape the shared token budget.

Cells publish results directly into the shared append-only life stream. They do not converse with each other. The foreground awareness sees the graph, integrates completed evidence, and alone decides whether to act, remember, deliver, or speak. This resembles dataflow and blackboard coordination more than a society of agents.

The first version deliberately limits cells to cognition. They have no tool schemas and cannot modify the environment. External effects remain ordered through Revo's foreground tool scheduler until conflict detection, read/write sets, and transactional commits are implemented.

## Human Preemption

The single human entrance is outside the workgraph queue. A new human message durably enters the life stream, aborts foreground cognition and every running cell, and receives the direct interaction lane. Provider calls that race with cancellation are charged to the shared budget but their outputs are marked stale and never adopted. Completion uses an atomic causal append: if human input entered the durable serialization order after the cell began but before its completion, the result cannot commit and the cell becomes interrupted. A human message after a completed result does not retroactively invalidate unrelated evidence.

Interrupted cells remain durable and do not automatically restart after the direct response. Revo must explicitly resume them with updated context, revise the graph, or cancel obsolete nodes. Human intervention therefore changes the world from which internal work continues; it is not merely another task competing for a worker slot.

## Influences and Rejections

- [pi](https://github.com/badlogic/pi-mono) separates steering from deferred follow-up and persists modern harness effects. Revo generalizes hard steering across every internal cell while rejecting per-session user surfaces.
- [Erlang/OTP supervision](https://www.erlang.org/docs/27/system/design_principles.html) separates worker computation from lifecycle supervision. Revo adopts failure isolation without treating workers as conversational identities.
- [PLaG / AsyncHow](https://arxiv.org/abs/2402.02805) treats asynchronous plans as graphs containing sequential and parallel constraints. Revo makes the graph durable and subordinate to one continuing subject.
- [LLM blackboard systems](https://openreview.net/forum?id=egTQgf89Lm) show the value of shared-state contribution over master-slave dialogue. Revo removes agent personae from the internal unit entirely.
- [AutoGen](https://arxiv.org/abs/2308.08155) demonstrates flexible multi-agent conversation. Revo treats that conversational organization as optional application structure, not the fundamental unit of internal concurrency.

The workgraph is not claimed as a new graph scheduler. The project-specific contribution is the production relation: one durable subject and human entrance, with parallel cognition represented as non-personal, dependency-ordered processes inside that subject.

## Current Boundary

Implemented now: durable cells, dependency gating, bounded parallel model calls, shared usage accounting, stale-result rejection, global human preemption, restart recovery, cancellation, and foreground integration.

Not yet implemented: parallel tool use inside cells, conflict-aware write sets, adaptive work stealing, critical-path scheduling, speculative competing cells, or semantic result merging. Those require evidence-backed scheduling semantics before they can safely enter one long-lived identity.
