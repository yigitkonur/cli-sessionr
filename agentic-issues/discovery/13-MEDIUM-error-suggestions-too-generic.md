# 13 · MEDIUM · `SessionNotFoundError.suggestion` is too generic — doesn't reference cwd or doctor

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/errors.ts:53-64`

## Evidence

```ts
// src/errors.ts:53-64
export class SessionNotFoundError extends SessionReaderError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, {
      …,
      suggestion: 'sessionr list --output json',
    });
  }
}
```

The suggestion is just "list everything as JSON". For an agent that already listed, this loops without progress.

## Fix

Make the suggestion context-aware. Include:

1. Whether any sessions exist at all (call `listSessions` with `limit=1` for a yes/no).
2. Prefix matches: if the sessionId is a prefix and matches multiple sessions in different cwds, list them in `detail.prefix_matches`.
3. A `sessionr doctor` link when the global session count is 0.

```ts
const all = await listSessions(undefined, 1);
const prefixMatches = (await listSessions()).filter(e => e.id.startsWith(sessionId));
super(`Session not found: ${sessionId}`, {
  code: 'SESSION_NOT_FOUND',
  exitCode: EXIT.NOT_FOUND,
  detail: {
    session_id: sessionId,
    prefix_matches: prefixMatches.slice(0, 5).map(e => ({id: e.id, cwd: e.cwd, source: e.source})),
    cwd: process.cwd(),
  },
  suggestion: all.length === 0
    ? 'No sessions found anywhere. Run `sessionr doctor` to verify your data dirs.'
    : prefixMatches.length > 1
      ? `Prefix "${sessionId}" matches ${prefixMatches.length} sessions; pass a longer prefix.`
      : `sessionr list --cwd current  (or --cwd all)`,
});
```

## Verification

```bash
sessionr read deadbeef --output json 2>&1 | jq '.error.suggestion, .error.detail.prefix_matches'
```

## Related

- [[discovery/07-MEDIUM-no-doctor-command]]
- [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]
