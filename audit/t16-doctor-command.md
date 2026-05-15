# T16 Doctor Command Audit

## Implemented

- Added `sessionr doctor` as a visible command.
- Added adapter `getDataDir()` metadata for every registered source.
- Added PATH binary resolvability checks with `src/utils/which.ts`.
- Added optional dependency warnings for SQLite-backed sources and Zed zstd decoding.
- Surfaced adapter-level discovery rejections through an `onWarning` callback on `listSessions`.
- Added `meta.warnings` to JSON `list`, `search`, and successful `read` envelopes when discovery warnings are present.
- Made `SessionNotFoundError` context-aware:
  - recommends `sessionr doctor` when no sessions exist globally;
  - includes `detail.prefix_matches` when a prefix is ambiguous;
  - otherwise recommends a cwd-aware list command.

## Verification

- `pnpm build`
- `pnpm exec tsx src/cli.ts doctor --output json`
- `pnpm exec tsx src/cli.ts list --output json --limit 1`
- `pnpm exec tsx src/cli.ts read deadbeef --output json`
