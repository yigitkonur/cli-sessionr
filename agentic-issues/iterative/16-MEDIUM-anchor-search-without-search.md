# 16 · MEDIUM · `read --anchor search` silently behaves like `tail` when `--search` is absent

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:231-233`, `src/slicer.ts` (sliceByTokenBudget)

## Evidence

```ts
// read.ts:231-233
const anchor = opts?.search ? 'search' as const : (opts?.anchor ?? 'head') as 'head'|'tail'|'search';
```

If the user passes `--anchor search` without `--search`, the ternary leaves `anchor === 'search'` but `search` is undefined; `sliceByTokenBudget` falls through to a default center index (essentially tail). No error.

## Fix

```ts
if (opts?.anchor === 'search' && !opts?.search) {
  throw new SessionReaderError('--anchor search requires --search <query>', {
    code: 'INVALID_ANCHOR_USAGE', exitCode: EXIT.USAGE,
    suggestion: 'sessionr read <id> --anchor search --search "<term>"',
  });
}
```

## Verification

```bash
sessionr read <id> --anchor search --output json 2>&1 | jq .error.code
# expect "INVALID_ANCHOR_USAGE"
```

## Related

- [[discovery/14-LOW-no-preset-detail-anchor-validation]]
