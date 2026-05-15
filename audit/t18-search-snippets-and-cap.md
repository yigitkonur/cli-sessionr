# T18 Search Snippets And Cap

## Changes

- Added capped per-session search matches with `message_index`, `snippet`, and `char_offset`.
- Added `list --search --max-sessions <n>` with bounds 1-200.
- Added `meta.search` for `list --search` JSON output: `query`, `sessions_scanned`, `sessions_available`, and `truncated`.

## Verification

- Passed: `pnpm build`
- Passed: `pnpm test`
- Passed: `node dist/cli.js search -q "deploy" --output json | jq '.results[0].matches[0]'`
- Passed: `node dist/cli.js --output json list -q "rare-term" | jq '.meta.search'`
- Passed: `node dist/cli.js --output json list -q "x" --max-sessions 100 | jq '.meta.search.sessions_scanned'`
