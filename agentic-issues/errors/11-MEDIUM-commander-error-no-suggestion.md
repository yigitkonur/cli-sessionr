# 11 · MEDIUM · Commander-wrapped errors lack `detail` / `suggestion` / `class`

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts:438-447`

## Evidence

```ts
// src/cli.ts:444-446
process.stdout.write(JSON.stringify({
  error: { code: 'USAGE_ERROR', message: msg, retry: false },
}, null, 2) + '\n');
```

Three fields. No `class`, no `detail`, no `suggestion`, no `retryable` → drift with `SessionReaderError.toJSON` (see [[output-contracts/09-HIGH-error-envelope-shape-inconsistency]]).

## Fix

Build a real `SessionReaderError` from the commander error and reuse `formatter.error(...)`:

```ts
const sre = new SessionReaderError(msg, {
  code: 'USAGE_ERROR',
  exitCode: EXIT.USAGE,
  detail: { commander_code: err.code },
  suggestion: 'sessionr --help',
});
process.stdout.write(formatter.error(sre) + '\n');
process.exitCode = EXIT.USAGE;
```

## Verification

```bash
sessionr --bogus list --output json 2>&1 | jq '.error | {class, code, suggestion}'
```

## Related

- [[output-contracts/09-HIGH-error-envelope-shape-inconsistency]]
