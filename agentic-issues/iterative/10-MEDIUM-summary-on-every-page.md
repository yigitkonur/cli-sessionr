# 10 · MEDIUM · `read` envelope embeds the full `session` summary on every page

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:191, 200, 264-265`

The `SessionSummary` (id, model, cwd, git_branch, total_messages, total_tokens_estimate, pages_estimate, duration, by_role) is included on every `read` page. For a 7-page paginated walk that's 7× the same metadata.

## Fix

Include `session` only on page 1 (or behind `--include-summary` / `--no-summary`):

```ts
if ((opts?.page ?? 1) === 1 || opts?.includeSummary) envelope.session = summary;
```

Or move the summary to a single `info` call and require the agent to fetch it once.

## Verification

```bash
sessionr --output json read <id> --page 2 | jq 'has("session")'   # expect false
sessionr --output json read <id>           | jq 'has("session")'   # expect true
```
