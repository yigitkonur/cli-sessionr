# 01 · CRITICAL · `send <bad-id>` crashes with "Cannot read properties of undefined (reading 'bin')"

**Context:** write-path · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/send.ts:55-58, 72-94`, `src/runners.ts:8-35`

## Evidence

Probe `_probes/65_send_bad_id.err` returns the JSON envelope:

```json
{ "error": { "code": "UNKNOWN_ERROR",
             "message": "Cannot read properties of undefined (reading 'bin')",
             "retry": false } }
```

Trace:

1. `resolveSource` (`send.ts:72-94`) returns `undefined as unknown as SessionSource` (line 93) when `sessionId` is provided but `--source` is omitted, intending the source to be auto-detected from a successful `loadSession`.
2. If `loadSession` fails (bad ID), the auto-detect block silently swallows (`send.ts:35-44`).
3. `buildResumeCommand(undefined, …)` (`runners.ts:8-35`) hits the `switch` with no `default` — TypeScript's `never` exhaustiveness check is not enforced because `source` is typed `SessionSource`.
4. The function implicitly returns `undefined`.
5. `spawnAndWait(cmd, cwd)` dereferences `cmd.bin` → TypeError.

The agent gets a stack-trace-grade error with no actionable code.

## Why this fails an agent

`UNKNOWN_ERROR` is a worst-case label. The agent has no indication this was a "bad id" failure (which is recoverable via list/info) vs an internal crash (which would warrant a bug report). Both are reported the same.

## Fix

1. In `runners.ts`, add an explicit exhaustiveness check + a guard at the top:

   ```ts
   export function buildResumeCommand(source, sessionId, message): RunCommand {
     if (!source) throw new SessionReaderError('Source could not be determined for resume', {
       code: 'SOURCE_UNKNOWN', exitCode: EXIT.NOT_FOUND,
       suggestion: 'sessionr info <id> --output json   (verify the session exists)',
     });
     switch (source) { … case 'zed': … }
     const _exhaustive: never = source;
     throw new SessionReaderError(`Unsupported source: ${_exhaustive}`, {code:'UNSUPPORTED_SOURCE', exitCode: EXIT.USAGE});
   }
   ```

2. In `send.ts:35-44`, do **not** swallow the `loadSession` error when an `id` was provided. Re-throw `SessionNotFoundError` so the agent sees `class:not_found, code:SESSION_NOT_FOUND` immediately.

3. Add `dst` exhaustiveness in `buildNewCommand` for symmetry.

## Verification

```bash
sessionr send deadbeef -m "ping" --output json 2>&1 | jq '.error | {class, code}'
# expect "not_found", "SESSION_NOT_FOUND"
```

## Related

- [[write-path/02-CRITICAL-detect-new-session-attaches-wrong-session]]
- [[write-path/11-LOW-runners-no-default-case]]
