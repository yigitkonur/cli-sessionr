# 07 · MEDIUM · `--if-changed` swallows `loadSession` errors and silently re-tries the full read

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts:104-117`

## Evidence

```ts
// src/cli.ts:104-117
if (readOpts.ifChanged) {
  const { loadSession } = await import('./discovery.js');
  const { computeETag } = await import('./etag.js');
  try {
    const s = await loadSession(sessionId, readOpts.source);
    const etag = computeETag(s);
    if (etag === readOpts.ifChanged) {
      process.exitCode = 42;
      return;
    }
  } catch {
    // proceed normally if session load fails
  }
}
await readCommand(sessionId, from, to, readOpts);
```

If `loadSession` fails (typo, deleted file, parse error), the swallow runs `readCommand` which then fails with a different error path. The agent sees a different error class than the one that actually occurred.

## Fix

Catch only `SessionNotFoundError`-style transient/race conditions; re-throw the rest. Better: don't pre-load — extend `readCommand` to accept `ifChanged` and short-circuit *inside* the same code path so there's only one place that loads the session.

```ts
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    // race with deletion — fall through to the normal not-found error path
  } else {
    throw err;
  }
}
```

## Verification

```bash
sessionr read deadbeef --if-changed abc --output json 2>&1 | jq .error.code
# expect "SESSION_NOT_FOUND" — same as without --if-changed
```

## Related

- [[iterative/01-HIGH-etag-not-in-read-response]]
- [[iterative/02-HIGH-if-changed-no-output-on-match]]
