# 06 · MEDIUM · `detail_hint.upgrade_options` lacks a `will_fit_in_current_budget` boolean

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:91-147`

## Evidence

`computeDetailHint` (`read.ts:91-147`) emits each upgrade with `estimated_tokens` and a `--tokens N+2000` command. There's no per-option flag that says "this upgrade fits inside the agent's current `--tokens` budget".

## Why this fails an agent

Agents pick presets under a budget. With only an estimate, they have to compute `estimated < my_budget`. With a `will_fit` boolean — and ideally `delta_vs_current_tokens` — they can decide in one branch.

## Fix

```ts
upgrade_options.push({
  preset: name,
  estimated_tokens: roundedEst,
  will_fit_in_current_budget: roundedEst <= currentBudget,
  delta_vs_current_tokens: roundedEst - currentReturnedTokens,
  command: `sessionr read ${sessionId} --preset ${name} --tokens ${Math.max(roundedEst + 2000, currentBudget)}`,
});
```

## Verification

```bash
sessionr --output json read <id> --tokens 8000 | jq '.meta.detail_hint.upgrade_options'
```

## Related

- [[iterative/13-LOW-jobstatus-no-cancelled]]
