# t06 send bad id and detect session audit

## Changes

- `send <bad-id>` now lets `loadSession` propagate `SessionNotFoundError` before command construction, so the JSON error envelope reports `SESSION_NOT_FOUND` with exit 3.
- `send --new` now detects a new session only when a recent entry belongs to the current `cwd`; it no longer falls back to the most recent session from another project.
- Missing runner sources now throw `SOURCE_UNKNOWN` with `EXIT.NOT_FOUND`, and both runner switches include `never` exhaustiveness checks.

## Verification

- `pnpm build` passed.
- `pnpm test` passed.
- `node dist/cli.js --output json send deadbeef -m "ping"` returned `SESSION_NOT_FOUND` and exit 3.
