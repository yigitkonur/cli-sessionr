# 04 · MEDIUM · `workflow` array in JSON help is incomplete and partly wrong

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts:415-420`

## Evidence

```ts
// src/cli.ts:415-420
workflow: [
  '1. sessionr list — discover sessions',
  '2. sessionr read <id> — read last page (cursor-paginated)',
  '3. Use cursor.prev / cursor.next to page through',
  '4. sessionr send <id> -f prompt.md — resume session',
],
```

- Step 2 says "read last page". `read` defaults to `--anchor head` (`src/commands/read.ts:233`), which is the **first** page. Off by 100%.
- The list omits `info`, `stats`, `search`, `context`, `--async` / `job` / `wait`, `prune`, `tag`. Agents discovering only via this array never find them.

## Why this fails an agent

Agents follow workflows literally. "Read last page" + actual head-first behavior means the agent re-reads the same opening turn over and over while paging forward. Tokens wasted, never reaches the recent state.

## Fix

```ts
workflow: [
  '1. sessionr list [--cwd current] — discover sessions for this project',
  '2. sessionr info <id> — cheap metadata (size, message counts, model)',
  '3. sessionr read <id> --tokens 4000 — first page (head); use --anchor tail for the most recent turn',
  '4. Page with cursor.next / cursor.prev or --page N',
  '5. sessionr stats <id> — full stats: tools, files modified, durations',
  '6. sessionr search -q "<text>" — find sessions by content',
  '7. sessionr send <id> -f prompt.md — resume the session synchronously',
  '8. sessionr send <id> -f prompt.md --async → sessionr wait <job-id> → sessionr read <id> --after N — long-running flows',
  '9. sessionr context <id> --tokens 8000 — export for cross-tool handoff',
],
```

Also surface this list in human `--help` (currently JSON-only).

## Verification

```bash
sessionr --output json help | jq '.workflow | length'   # expect ≥9
```

## Related

- [[discovery/02-HIGH-hidden-commands-referenced-in-actions]]
- [[iterative/04-HIGH-job-poll-loses-source-tokens-preset]]
