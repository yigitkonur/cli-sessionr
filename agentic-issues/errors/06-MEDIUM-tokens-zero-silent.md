# 06 · MEDIUM · `--tokens 0` and negative tokens silently truncate to one message, exit 0

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:187-188`, `src/slicer.ts`

## Evidence

Probe `_probes/68_read_tokens_zero.txt`: `read <id> --tokens 0` → exit 0, returns one message, `token_budget: 0`.

`read.ts:187-188`:
```ts
const rawBudget = opts?.tokens ?? getDefaultTokenBudget();
const tokenBudget = Math.min(rawBudget, MAX_CHUNK_BUDGET);
```
No lower-bound check; `slicer.sliceByTokenBudget` falls through to "fit one message".

## Fix

```ts
if (opts?.tokens != null && opts.tokens <= 0) {
  throw new SessionReaderError('--tokens must be > 0', {
    code: 'INVALID_TOKEN_BUDGET', exitCode: EXIT.USAGE,
    detail: { provided: opts.tokens },
    suggestion: 'sessionr read <id> --tokens 4000',
  });
}
```

## Verification

```bash
sessionr read <id> --tokens 0  --output json 2>&1 | jq '.error.code'   # expect "INVALID_TOKEN_BUDGET"
sessionr read <id> --tokens -5 --output json 2>&1 | jq '.error.code'   # expect "INVALID_TOKEN_BUDGET"
```

## Related

- [[discovery/06-MEDIUM-list-numeric-bounds-not-validated]]
- [[errors/04-MEDIUM-exit-codes-mostly-unused]] (PARTIAL exit when truncating)
