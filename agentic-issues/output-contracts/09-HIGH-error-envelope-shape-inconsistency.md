# 09 · HIGH · Error envelopes have **two different shapes** depending on origin

**Context:** output-contracts · **Severity:** High · **Status:** open
**Owners:** `src/cli.ts:438-447`, `src/errors.ts:41-50`, `src/output/json.ts:75-84`, `src/commands/diff.ts:60`, `src/commands/prune.ts:94-99`

## Evidence

Shape A — Commander/usage errors caught at the top level (`src/cli.ts:444`):
```jsonc
{ "error": { "code": "USAGE_ERROR", "message": "...", "retry": false } }
```
Three fields. No `detail`, no `suggestion`, no `class`, no `retryable`.

Shape B — `SessionReaderError.toJSON()` (`src/errors.ts:41-50`):
```jsonc
{ "error": { "code": "...", "message": "...", "detail": {...}, "suggestion": "...", "retry": false } }
```
Five fields. Note `retry` (Shape A) vs `retry` (Shape B) — same key but Shape A always emits `false`.

Shape C — bespoke envelopes in `diff.ts:60` and `prune.ts:97`:
```jsonc
{ "error": { "code": "DIFF_FAILED", "message": "..." } }    // no `retry` at all
{ "error": { "code": "PRUNE_FAILED", "message": "...", "retry": false } }
```

Shape D — JSON formatter fallback for non-`SessionReaderError` (`src/output/json.ts:80`):
```jsonc
{ "error": { "code": "UNKNOWN_ERROR", "message": "...", "retry": false } }
```

That's four shapes. Probe `_probes/12_read_no_args_json.txt` is Shape A; `_probes/14_read_bad_id_json.err` is Shape B; `_probes/65_send_bad_id.err` is Shape D (`UNKNOWN_ERROR` for an undefined-cmd crash from buildResumeCommand).

## Why this fails an agent

Agents must defensively probe for every field on every error. That code branches grow unbounded. The skill's recommended error shape is one consistent record:

```jsonc
{
  "ok": false,
  "schema_version": "v1",
  "error": {
    "class": "validation" | "not_found" | "auth" | "conflict" | "transient" | "internal",
    "code":  "MISSING_FLAG" | "SESSION_NOT_FOUND" | …,
    "message": "human-readable",
    "detail": { /* machine-readable context */ },
    "suggestion": "next command to try, or null",
    "retryable": false
  }
}
```

## Fix

1. Centralize error emission. Add a single helper `emitError(err, isJson)` that always normalizes to the recommended shape (filling missing fields with sensible defaults).
2. Delete the bespoke `JSON.stringify({error:…})` calls in `diff.ts`, `prune.ts`, and `cli.ts`. Force them through the helper.
3. In `SessionReaderError.toJSON`, derive `class` from `exitCode`:

```ts
function classOf(code: ExitCode): string {
  switch (code) {
    case EXIT.USAGE: return 'validation';
    case EXIT.NOT_FOUND: return 'not_found';
    case EXIT.AUTH: return 'auth';
    case EXIT.RATE_LIMITED: return 'transient';
    case EXIT.PARTIAL: return 'partial';
    default: return 'internal';
  }
}
```

4. Rename `retry` → `retryable` for skill compliance (keep `retry` as an alias for one release).

## Verification

```bash
for cmd in 'read deadbeef' 'send' 'send -m a -f b' 'prune' 'diff a b' 'read'; do
  echo "== $cmd =="
  sessionr --output json $cmd 2>&1 | jq '.error | {class, code, retryable, has_message: has("message"), has_suggestion: has("suggestion")}'
done
# expect every record to have class, code, retryable, has_message=true
```

## Related

- [[output-contracts/04-CRITICAL-errors-go-to-stderr-in-json-mode]]
- [[errors/03-MEDIUM-no-class-field-in-error]]
