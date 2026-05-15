# 07 · MEDIUM · `next_action` only exists on `read` — list/info/stats/context/diff/jobs have only `actions[]`

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** every emitter

## Evidence

`SliceMeta.next_action` (`src/types.ts:175-181`) is populated only by `read` (via `injectNextAction`). Other commands return only an unranked `actions[]` array.

## Why this fails an agent

The skill's iterative-loop pattern wants a single canonical "what should I do next" pointer per response. Agents with multiple options pick poorly without a primary recommendation.

## Fix

Add `next_action` (single object, the recommended one) alongside `actions[]` (the menu) in every envelope:

| Command | `next_action` candidate |
|---|---|
| `list` (1+ entries) | `read <entries[0].id>` |
| `list` (0 entries) | `doctor` |
| `info` | `read <id>` |
| `stats` | `read <id>` (or `context` if many tokens) |
| `context` | `send --new -s <source> -f <exported.md>` |
| `diff` | `read <id>` for the larger session |
| `jobs` | `wait <first running>` if any |
| `prune --dry-run` | `prune --yes` (after the destructive fix) |

## Verification

```bash
for c in 'list' 'info <id>' 'stats <id>' 'context <id>' 'jobs'; do
  sessionr --output json $c | jq '.meta.next_action.command'
done
```

## Related

- [[iterative/04-HIGH-job-poll-loses-source-tokens-preset]]
- [[discovery/08-MEDIUM-list-footer-only-one-tip]]
