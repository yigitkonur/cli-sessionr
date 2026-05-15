# 03 · MEDIUM · `error.class` field missing — agents must regex on `error.code` strings

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/errors.ts:14-50`

## Evidence

```ts
// src/errors.ts:41-50
toJSON(): Record<string, unknown> {
  const obj: Record<string, unknown> = { code: this.code, message: this.message };
  if (Object.keys(this.detail).length > 0) obj.detail = this.detail;
  if (this.suggestion) obj.suggestion = this.suggestion;
  obj.retry = this.retry;
  return obj;
}
```

No `class`. The skill recommends a small enum: `validation | not_found | auth | conflict | transient | partial | internal`.

## Why this fails an agent

Agents writing retry logic want to branch on **class**, not on a long-tail of `code` strings (`SESSION_NOT_FOUND`, `INVALID_PRESET`, `INVALID_ROLE`, `MISSING_MESSAGE`, …). With a class, retry logic stays small and consistent. Without it, the agent maintains a lookup table that grows with every release.

## Fix

```ts
// src/errors.ts
export type ErrorClass = 'validation' | 'not_found' | 'auth' | 'conflict' | 'transient' | 'partial' | 'internal';

function classOf(exit: ExitCode): ErrorClass {
  switch (exit) {
    case EXIT.USAGE: return 'validation';
    case EXIT.NOT_FOUND: return 'not_found';
    case EXIT.AUTH: return 'auth';
    case EXIT.RATE_LIMITED: return 'transient';
    case EXIT.PARTIAL: return 'partial';
    case EXIT.OK:
    case EXIT.NO_CHANGES: return 'internal';   // shouldn't reach here
    default: return 'internal';
  }
}

toJSON() {
  return {
    class: classOf(this.exitCode),
    code: this.code,
    message: this.message,
    ...(Object.keys(this.detail).length > 0 ? {detail: this.detail} : {}),
    ...(this.suggestion ? {suggestion: this.suggestion} : {}),
    retryable: this.retry,
  };
}
```

(`retry` → `retryable` aligns with the skill's wording. Keep `retry` as alias for one release.)

## Verification

```bash
sessionr read deadbeef --output json 2>&1 | jq '.error | .class, .retryable'
# expect "not_found", false
```

## Related

- [[output-contracts/09-HIGH-error-envelope-shape-inconsistency]]
- [[errors/09-MEDIUM-no-retry-semantics]]
