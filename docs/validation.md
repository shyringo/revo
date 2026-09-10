# Validation and Limits

Evidence recorded through 2026-09-05 before the first public release.

## Correctness

```sh
npm ci --ignore-scripts
npm run check
```

The release candidate passes 85 deterministic tests without paid inference. Coverage includes graceful/forced wake-sleep continuity, durable human priority, attention-budgeted proactive speech, subject-preserving parallel work cells, unfinished-work admission bounds, dependency gating, atomic causal result commits, explicit post-interruption resumption, crash recovery and global preemption, durable-human race rejection, terminal cancellation, stale-response races, tool ordering and validation, destructive-only approvals, pi-style read/write/edit/bash behavior, BOM/CRLF-preserving multi-edit, compact/expanded tool evidence, intent/effect recovery, torn JSONL recovery, snapshots/checksums, compaction transactions, Chinese memory retrieval, pi Editor CJK/multiline/history input, TUI mouse scrolling/projections/resource release, plugin disposal, offline deliveries and outreach, model adapters, and local documentation links.

The same suite passes on:

- Windows 11, Node.js 24.
- WSL Ubuntu, Node.js 24.
- GitHub Actions is configured for Windows and Ubuntu with Node.js 22 and 24; public CI remains unproven until publication.

## Provider

The installed configuration is locked to OpenCode Go `deepseek-v4-flash` at `https://opencode.ai/zen/go/v1/chat/completions`.

Verified against the live service:

- `/models` returns HTTP 200 and includes `deepseek-v4-flash`.
- Non-streaming and streaming Chat Completions return HTTP 200.
- Streaming ends with `[DONE]` and `stream_options.include_usage` returns complete usage.
- Tool calling, Chinese interaction, and direct streamed replies have completed successfully.
- A local deterministic provider drove the complete foreground path to open two work cells; durable order `start A -> start B -> complete A -> complete B` verifies real overlap rather than sequential simulation.
- The provider accepts a non-thinking request, but may still return reasoning content; Revo therefore accounts actual usage instead of assuming the control was honored.

Run `revo --doctor` to repeat catalog, credential, Constitution, and life-integrity checks without inference.

## TUI Projection Benchmark

```sh
npm run benchmark
```

Synthetic workload: 10,000 visible CHAT events, 9 iterations, median measurement.

| Environment | First projection | Cached redraw | Offline status |
| --- | ---: | ---: | ---: |
| Windows 11 build 26200, Core i5-1340P, 31.6 GB RAM, Node 24.1.0 | 30.48 ms | 0.01 ms | 0.32 ms |

The benchmark performs no model calls and writes no life state. These numbers demonstrate the current projection cache under one workload; they do not prove ten-year scale or bound provider latency.

## Packaging

- A clean release-tree copy completes `npm ci` and the full test suite.
- `npm pack --dry-run` is restricted by an explicit file whitelist.
- Windows and Linux package checks include no credential, life log, snapshot, obsolete Web UI, upstream checkout, or generated transcript.
- Local Markdown links and public candidate paths are audited automatically.

## Known Limits

- The complete segmented JSONL is still loaded into memory at startup. Ten-year operation needs indexed disk projections and retention-aware segmentation.
- The life lock prevents concurrent local processes, not multiple machines sharing one state directory.
- Memory retrieval is local lexical English/CJK matching, not semantic embeddings.
- Approvals are guardrails, not an operating-system sandbox. Approved commands inherit process permissions.
- Compaction and sleep consolidation depend on the configured model; deterministic fallback preserves evidence but has lower summary quality.
- Constitution conflict ordering, amendment authority, interpretation, and emergency rules are not yet formalized.
- Plugins are trusted local code and have full process permissions.
- Only one local human owner and one Revo identity are supported.
