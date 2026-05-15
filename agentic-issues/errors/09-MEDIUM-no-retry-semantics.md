# 09 · MEDIUM · No command (except `wait` timeout) ever sets `retry: true`

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** all error-throw sites

## Evidence

`grep -rn 'retry:\s*true' src/` returns one match: `src/commands/job.ts:94` (`JOB_TIMEOUT`). Everywhere else `retry: false` (often by default).

## Why this fails an agent

Agents distinguishing "should I retry?" from "should I give up?" rely on the boolean. If everything says `retry: false`, the agent never retries even genuinely transient failures (file just deleted, file currently being written to, spawned tool transient network glitch).

## Fix

Annotate transient cases:

| Error | retryable? |
|---|---|
| `SESSION_NOT_FOUND` | `true` if `process.cwd()` recently changed or session is on a synced drive (best effort: always `false` is fine, but document the case). |
| `PARSE_ERROR` mid-read | `true` — file may be mid-flush from a live writer. |
| `SPAWN_ERROR` (`ENOENT`) | `false` — binary missing, not transient. |
| Job tool exit-code matching network/429 | `true`. |
| Job timeout | `true` (already done). |
| Anything from a `Promise.allSettled` discovery rejection | `true` — adapter error may be transient. |

Default for new errors should be `retry: undefined` (forcing the author to decide).

## Verification

```bash
sessionr read mid-write-session --output json 2>&1 | jq '.error.retryable'   # expect true
```

## Related

- [[errors/03-MEDIUM-no-class-field-in-error]]
- [[errors/10-MEDIUM-parse-errors-silently-swallowed]]
