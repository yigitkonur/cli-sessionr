# 07 · MEDIUM · Job metadata write is not atomic — partial / lost jobs possible after crash

**Context:** write-path · **Severity:** Medium · **Status:** open
**Owners:** `src/jobs.ts` (createJob), `src/commands/send.ts:227-255`

## Evidence

`createJob` writes the `<job>.json` file with `writeFileSync(jobPath(id), JSON.stringify(job))`. The parent then prints the job ID and exits. If the parent is OOM-killed between `spawn(...)`/`unref()` and `writeFileSync(...)`, the child is alive but no metadata file describes it. Subsequent `sessionr jobs` won't list it, `wait` won't find it, `cancel` can't reach it.

Symmetric problem on update: `finalizeJob` mutates the in-memory object then writes (`updateJob`). A concurrent `cancel` racing `finalize` can interleave.

## Fix

Atomic write via temp + rename:

```ts
import { writeFileSync, renameSync } from 'node:fs';
const tmp = jobPath(id) + '.tmp';
writeFileSync(tmp, JSON.stringify(job, null, 2));
renameSync(tmp, jobPath(id));    // atomic on POSIX
```

Add a per-job advisory lock (`flock` on `*.lock`, or `proper-lockfile`) around finalize/cancel.

## Verification

```bash
# Simulate parent crash mid-write (kill -9 before write completes).
sessionr send --new -s claude --async -m hi & PID=$!; sleep 0.05; kill -9 $PID
sessionr jobs --output json   # the job should still be listable, status='running'
```

## Related

- [[write-path/08-MEDIUM-async-no-explicit-exit-code]]
- [[write-path/09-MEDIUM-finalizejob-mutates-input]]
