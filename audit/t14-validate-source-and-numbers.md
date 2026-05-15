# t14 Validate Source And Numbers

## Scope

- Validate source names at the CLI boundary before discovery.
- Resolve lightweight source aliases to canonical session sources.
- Reject invalid numeric option values instead of letting `parseInt` produce empty or misleading results.

## Changes

- Added `resolveSource()` with aliases:
  - `cc` -> `claude`
  - `cli` and `copilot-cli` -> `copilot`
  - `cx` -> `codex`
  - `gm` -> `gemini`
  - preserved existing `droid` -> `factory`
- Added `parseBounded()` for integer-only bounds checks.
- Applied source validation to `list`, `read`, `info`, `stats`, `search`, `send`, `context`, `diff`, `tag`, and `prune`.
- Applied numeric validation to `--limit`, `--offset`, `--page`, `--before`, `--after`, `--tokens`, `--top`, `--max-sessions`, `--timeout`, and `--interval`.

## Verification

```bash
pnpm build
pnpm test
node dist/cli.js list claud --output json 2>&1 | jq .error.code
node dist/cli.js list cc --output json | jq '.sessions[0].source'
node dist/cli.js list -n 0 --output json 2>&1 | jq .error.code
node dist/cli.js list -n -5 --output json 2>&1 | jq .error.code
node dist/cli.js list --offset -1 --output json 2>&1 | jq .error.code
```

All checks passed.
