# 12 · LOW · `prune --older-than 0d` accepted, would purge **everything** if combined with the future `--yes`

**Context:** errors · **Severity:** Low · **Status:** open
**Owners:** `src/commands/prune.ts:5-22`

`parseDuration` accepts `0d` (matches the `\d+` regex, multiplier of 0 → cutoff = `now()` → every session is "older than now"). Today this is masked by [[destructive/01-CRITICAL-prune-yes-fakes-deletion]] (prune is a no-op). After that fix, `0d` becomes catastrophic.

## Fix

```ts
if (value <= 0) {
  throw new SessionReaderError('Duration must be > 0', {
    code: 'INVALID_DURATION', exitCode: EXIT.USAGE,
    suggestion: 'sessionr prune --older-than 7d --dry-run',
  });
}
```

## Verification

```bash
sessionr prune --older-than 0d --output json 2>&1 | jq .error.code  # expect "INVALID_DURATION"
```
