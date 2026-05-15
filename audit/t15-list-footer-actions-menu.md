# T15 List Footer Actions Menu Audit

## Scope

- Replaced the one-line text/TTY list tip with context-aware footer menus.
- Added structured list cursors with command, offset, and limit fields.
- Added `meta.next_action` to list, info, stats, context, diff, and jobs JSON emitters.
- Unhid commands referenced by action menus in top-level help.

## Verification Results

- Pass: `pnpm build`
- Pass: `pnpm test` (5 files, 77 tests)
- Pass: `node dist/cli.js --help` lists stats, info, search, diff, tag, prune, context, jobs, job, wait, and cancel.
- Pass: `node dist/cli.js list --output json | jq '.meta.next_action.command'` returns a non-empty command.
- Pass: `node dist/cli.js list --output json | jq '.cursor.next | type'` returns `"object"` when another page exists.
- Pass: `node dist/cli.js list --output json | jq '.cursor.next.offset // empty'` returns a number when another page exists.
- Pass: `script -q /dev/null env -u NO_COLOR node dist/cli.js list -n 1` renders Next steps, Pagination, and Filtering footer sections.
- Pass: `script -q /dev/null env -u NO_COLOR node dist/cli.js list nonexistent` renders the empty-state menu.
