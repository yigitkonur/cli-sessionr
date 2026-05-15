# 03 · MEDIUM · `detectNewSession` falls back to "any recent session" — can attach the agent to an unrelated repo

**Context:** destructive · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/send.ts:279-291`

## Evidence

```ts
// src/commands/send.ts:283-289
async function detectNewSession(source, cwd): Promise<string | null> {
  try {
    const entries = await listSessions(source, 5);
    const match = entries.find((e) => e.cwd === cwd);
    return match?.id ?? entries[0]?.id ?? null;   // ← falls back to entries[0]
  } catch { return null; }
}
```

After `send --new`, the parent looks for a session that just got created in the current cwd. If it can't find one (timing race, source adapter glitch, `cwd` mismatch because the upstream tool wrote a different path), it returns **the most recent session anywhere on disk**, regardless of source or cwd. The caller then receives that as `session_id` and treats subsequent `read --after`/`send <id>` calls as if it were the just-created session.

## Why this fails an agent

Cross-project leakage. An agent kicks off a new Claude session in `/Users/me/projA`, the upstream `claude` CLI takes a moment to flush the file, `detectNewSession` doesn't see it yet — and silently returns the ID of an active session in `/Users/me/projB`. The agent then resumes `projB` with messages destined for `projA`. **Data corruption.**

## Fix

Drop the unsafe fallback. Surface a partial-status:

```ts
async function detectNewSession(source, cwd) {
  // poll for up to N ms — sessions can take a moment to flush
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const entries = await listSessions(source, 10);
    const match = entries.find((e) => e.cwd === cwd && Date.now() - e.updatedAt.getTime() < 30_000);
    if (match) return match.id;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;     // never fall back to an unrelated session
}

// caller
if (!finalSessionId) {
  throw new SessionReaderError('Tool completed but new session was not detected in cwd', {
    code: 'NEW_SESSION_NOT_DETECTED',
    exitCode: EXIT.PARTIAL,
    detail: { cwd, source, hint: 'check `sessionr list --cwd current --source ' + source + '`' },
    suggestion: 'sessionr list --cwd current -n 5',
    retry: true,
  });
}
```

## Verification

Run `send --new` in `/tmp` while the most recent global session is in another cwd. Confirm the response is `NEW_SESSION_NOT_DETECTED` (or returns the actual new session in `/tmp`), **never** the unrelated session.

## Related

- [[write-path/02-CRITICAL-detect-new-session-attaches-wrong-session]]  (same bug, different lens)
- [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]
