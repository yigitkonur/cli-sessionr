# 11 · MEDIUM · `pages_estimate` is preset-derived, not budget-derived — page numbering breaks across budget changes

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:17-19`, `src/slicer.ts` (estimatePageCount)

## Evidence

`buildSessionSummary` calls `estimatePageCount(messages, budget, preset)`. The preset's `maxContentChars` participates in the estimate, but agents iterate by `--page N` against the actual `tokenBudget`. Changing the budget mid-walk shifts page boundaries; the previously-reported `pages_estimate` becomes stale.

## Fix

Make `pages_estimate` depend solely on the token budget passed in (preset only affects truncation). Document that page numbers are stable only for a given `(budget, preset)` pair, and include `(budget, preset)` in `meta` so agents can detect drift.

## Verification

```bash
P_A=$(sessionr --output json read <id> --tokens 2000 | jq .session.pages_estimate)
P_B=$(sessionr --output json read <id> --tokens 8000 | jq .session.pages_estimate)
test "$P_A" != "$P_B"   # they SHOULD differ — and meta.budget reflects which produced which
```
