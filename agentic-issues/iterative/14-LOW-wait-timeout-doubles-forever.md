# 14 · LOW · `wait` timeout suggestion doubles indefinitely (no cap)

**Context:** iterative · **Severity:** Low · **Status:** open
**Owners:** `src/commands/job.ts:88-95`

`suggestion: \`sessionr wait ${jobId} --timeout ${timeout * 2}\``. After 5 retries that's 32×. Cap at e.g. 1 hour:

```ts
const next = Math.min(timeout * 2, 3600);
suggestion: `sessionr wait ${jobId} --timeout ${next}`,
```
