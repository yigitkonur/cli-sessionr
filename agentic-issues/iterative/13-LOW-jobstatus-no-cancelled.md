# 13 · LOW · `JobStatus` lacks a `cancelled` distinct from `failed`

**Context:** iterative · **Severity:** Low · **Status:** open
**Owners:** `src/types.ts:224`, `src/jobs.ts` (cancelJob)

`JobStatus = 'running' | 'completed' | 'failed'`. `cancelJob` sets `status='failed'` with `exit_code=130` (SIGTERM convention). Agents reading `failed` retry the send, not knowing it was an intentional cancel.

## Fix

```ts
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
// in cancelJob: job.status = 'cancelled'
```

Update the `class` derivation: `cancelled` → no retry.

## Verification

```bash
JID=$(sessionr send --new -s claude --async -m hi --output json | jq -r .data.job_id)
sessionr cancel $JID --output json
sessionr job $JID --output json | jq .data.status   # expect "cancelled"
```

## Related

- [[write-path/04-HIGH-job-status-only-stderr-heuristic]]
