# 06 · HIGH · `send` exits 0 even when the new session can't be found — agent thinks it succeeded

**Context:** write-path · **Severity:** High · **Status:** open
**Owners:** `src/commands/send.ts:131-150`

## Evidence

```ts
// src/commands/send.ts:131-150
let finalSessionId = sessionId;
if (isNew) finalSessionId = await detectNewSession(resolvedSource, cwd);

if (!finalSessionId) {
  const result = {
    api_version: 1,
    data: {
      status: 'completed', source: resolvedSource, exit_code: 0,
      is_new_session: isNew, message: 'Tool completed but session could not be detected',
    },
  };
  console.log(JSON.stringify(result, null, 2));
  return;       // exit 0
}
```

`status: 'completed'` and `exit_code: 0` are returned with a friendly "could not be detected" message. The exit code is unset (defaults to 0).

## Why this fails an agent

The agent receives `status: completed`, parses the JSON, and tries to `read --after 0` from the (null) `session_id`. The follow-up `read` then errors with NOT_FOUND. The agent has to special-case the absence of `session_id` despite `status: completed`. Worse, an agent that doesn't notice `session_id: null` retries `send`, creating yet another orphan session.

## Fix

Throw `EXIT.PARTIAL`:

```ts
if (!finalSessionId) {
  throw new SessionReaderError('Tool completed but new session could not be detected', {
    code: 'NEW_SESSION_NOT_DETECTED',
    exitCode: EXIT.PARTIAL,
    detail: { source: resolvedSource, cwd, hint: 'session may take a moment to flush' },
    suggestion: `sessionr list --cwd current --source ${resolvedSource} -n 5`,
    retry: true,
  });
}
```

Combine with the polling fix from [[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]] so the partial state is rare.

## Verification

```bash
# Force the detect failure (e.g. send with --source set to one whose adapter is broken).
sessionr send --new -s broken -m hi --output json; echo $?
# expect exit 10 (PARTIAL), error.code = NEW_SESSION_NOT_DETECTED, retryable=true
```

## Related

- [[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]]
- [[errors/04-MEDIUM-exit-codes-mostly-unused]] (PARTIAL)
