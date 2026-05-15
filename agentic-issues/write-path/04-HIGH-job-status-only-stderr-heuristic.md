# 04 · HIGH · Async job "failed" status inferred from any stderr presence — false positives + false negatives

**Context:** write-path · **Severity:** High · **Status:** open
**Owners:** `src/jobs.ts:113-124`

## Evidence

The async path stores stdout/stderr in files and detects completion by checking if the PID is still alive. To decide success vs failure, `finalizeJob` reads the stderr file and treats **any** content as failure (and sets `exit_code = 1`). False positives: tool prints warnings to stderr → marked failed. False negatives: tool crashes silently without writing stderr → marked completed with exit 0.

(See the parallel sub-agent's audit of `src/jobs.ts` for line numbers — the heuristic is the central problem.)

## Why this fails an agent

The agent polls `sessionr wait <job-id>` and gets `status: "failed"` for a job that actually succeeded with a stderr deprecation warning. It re-sends the prompt, double-billing the API. Or it gets `status: "completed", exit_code: 0` for a job that crashed — and reads "new messages" that don't exist.

## Fix

Capture the actual exit code via a wrapper. Pick one:

1. Wrap with `bash -c` and write the exit code to a sidecar file:
   ```ts
   spawn('bash', ['-c', `${cmd.bin} ${args.join(' ')}; echo $? > ${jobPath(id)}.exit`], …)
   ```
   `finalizeJob` reads `.exit` once it exists.

2. Skip `detached: true` — keep the parent alive in a watchdog process that exits as soon as the child exits, writing the exit code first.

3. Use `nohup`-style indirection that always writes a final line to a status sidecar.

Whichever route, **use the real exit code**, not a stderr-presence heuristic. Add `'cancelled'` to `JobStatus` (see [[iterative/13-LOW-jobstatus-no-cancelled]]).

## Verification

```bash
# Tool that exits 0 with stderr warning:
sessionr send <id> -m "prompt that triggers a warning" --async --output json
# poll → expect status:"completed", exit_code:0

# Tool that exits 137 (SIGKILL) silently:
sessionr send <id> -m "trigger sigkill" --async --output json
# poll → expect status:"failed", exit_code:137
```

## Related

- [[write-path/03-CRITICAL-spawn-stdio-pipes-dropped]]
- [[iterative/13-LOW-jobstatus-no-cancelled]]
