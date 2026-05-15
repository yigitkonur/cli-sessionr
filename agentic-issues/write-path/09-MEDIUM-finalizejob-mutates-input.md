# 09 · MEDIUM · `finalizeJob` mutates its input object — caller-side race conditions

**Context:** write-path · **Severity:** Medium · **Status:** open
**Owners:** `src/jobs.ts` (finalizeJob)

`finalizeJob(job)` mutates the input `Job` and writes it via `updateJob`. Any caller who held a reference to the pre-finalize state silently sees the post-finalize state, and a follow-on read of the same struct from disk could race with the write.

## Fix

Return a fresh object; never mutate the input:

```ts
const finalized: Job = { ...job, status: 'completed', completed_at: nowIso(), exit_code: code };
updateJob(finalized);
return finalized;
```

Combine with a per-job advisory lock (see [[write-path/07-MEDIUM-job-persistence-not-atomic]]).

## Verification

Unit test: take a snapshot of `job` before `finalizeJob`, finalize, re-read snapshot — must equal the original.
