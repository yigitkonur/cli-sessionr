# 08 · MEDIUM · TTY/text `list` footer prints **one** tip and never explains how to use the result

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/output/tty.ts:118-121`, `src/output/plain.ts:116-118`

This is the issue the user explicitly called out in their prompt:

> *it lists the sessions but doesn't explain in the footer how to actually read or use those sessions. because of that, it needs to keep guiding the user toward the next command instead of leaving them stuck.*

## Evidence

`src/output/tty.ts:118-121`:
```ts
if (entries.length > 0) {
  lines.push('');
  lines.push(chalk.dim(`Tip: sessionr read ${shortId(entries[0].id)} to open a session`));
}
```

`src/output/plain.ts:116-118`: identical except no chalk.

There is no:
- multi-step menu (`read`/`stats`/`info`/`send`)
- guidance for when entries are empty
- mention of the `--cwd current` shortcut
- mention of `info` (cheap) vs `read` (expensive)
- pagination hint ("21 more — `sessionr list --offset 20`")

## Why this fails an agent (and a human)

The user has to invent the next step. Both humans and agents already received the IDs — what's missing is the menu of *what to do with them*. `actions[]` exists in the JSON envelope (good), but the human-facing footer surfaces only one tip.

## Fix

Render a menu, derived from `actions[]`. Suggested footer (TTY):

```
20 sessions  ·  page 1/171  ·  cwd: ~/dev/lets-talk

Next steps
  sessionr read   <id>           Read messages (token-budgeted)
  sessionr info   <id>           Metadata only (cheap)
  sessionr stats  <id>           Tools used, files modified, durations
  sessionr send   <id> -f p.md   Resume the session

Pagination
  sessionr list --offset 20      Next page

Filtering
  sessionr list --cwd current    Only this project
  sessionr list -q "deploy"      Search by content
```

When `entries.length === 0`:

```
No sessions matched.
  sessionr doctor                See which sources / data dirs are configured
  sessionr list --cwd all        Show sessions from every project
  sessionr send --new -s claude -f prompt.md   Start a new session
```

## Verification

```bash
sessionr list | tail -n +20    # expect a multi-line menu
sessionr list claude_typo      # empty case → expect a different menu
```

## Related

- [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]
- [[discovery/02-HIGH-hidden-commands-referenced-in-actions]]
- [[iterative/07-MEDIUM-no-next-action-on-list-info-stats]]
