# Contributing

Revo is currently in design review before its first public release.

## Development

Requirements: Node.js 22 or newer.

```sh
npm install --ignore-scripts
npm run check
npm run benchmark
```

Keep changes scoped and add tests for lifecycle, durability, cancellation, context projection, terminal layout, or tool-side effects as appropriate. Tests must not require a paid model call.

## Design Standard

Evaluate harness changes by the relationship they create between model, humans, and environment: perception, priority, memory, authority, effects, responsibility, and time. Preserve the awake contract, durable human priority, Constitution versioning, ordered effects, and explicit uncertainty.

Do not commit credentials, life logs, generated transcripts, private configuration, upstream source checkouts, or obsolete Web UI files.
