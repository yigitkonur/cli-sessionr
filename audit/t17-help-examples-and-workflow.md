# T17 Help Examples And Workflow Audit

## Scope

- Added human `Examples:` blocks for top-level help and each command present in this worktree.
- Skipped `doctor` because this worktree does not define that command.
- Updated `--preset` help text with rough per-preset token estimates.
- Updated JSON help workflow ordering to include `info`, `stats`, `search`, `context`, and async job flow.
- Added human top-level exit-code documentation for 0, 1, 2, 3, 4, 5, 10, and 42.

## Verification

- Passed: `pnpm build`
- Passed: `pnpm test` (5 files, 77 tests)
- Passed: `node dist/cli.js read --help | grep -A2 'Examples:'`
- Passed: `node dist/cli.js list --help | grep -A2 'Examples:'`
- Passed: `node dist/cli.js send --help | grep -A2 'Examples:'`
- Passed: `node dist/cli.js --help | grep -E '^  [0-9]+\s'` (8 rows)
- Passed: `node dist/cli.js --output json help | jq '.workflow | length'` (9)
- Passed: `node dist/cli.js read --help | grep -E 'minimal.*token|standard.*token|verbose.*token'`
