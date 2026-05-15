# Resume workflow — send / job / wait / cancel

How to push a follow-up prompt back into an existing session, or start a new session, without losing your context or burning unguarded API budget.

## Sync vs async

**Sync** (`sessionr send <id> -m "..."`): blocks until the upstream tool exits. Returns the new messages inline.

- Use when the response is short (< 30s estimate) AND the agent can stall.
- Returns the deltas in the response body — no follow-up read needed.
- On non-zero tool exit: `TOOL_ERROR` with `detail.stderr_tail` (last 50 lines of the spawned tool's stderr).

**Async** (`sessionr send <id> -m "..." --async`): forks a detached child, writes a job record, returns immediately.

- Use for anything > 30s, anything where the agent should keep working, or anything you want to monitor live.
- Returns `job_id` immediately. Status is `running`.
- Pair with `sessionr wait <job_id>` (block until terminal) or `sessionr job <job_id>` (poll once).
- After completion, run `sessionr read <id> --after <message_count_before>` to see only the new messages. The `actions[]` array of the `job` envelope provides this command pre-built with the original `--source/--tokens/--preset` carried forward (the `read_back` field).

## Session lookup

If the user gave a session id, sessionr resolves it (full or unique-prefix). If the prefix is ambiguous, `SESSION_NOT_FOUND` returns `error.detail.prefix_matches[]` — pick the right one and re-issue with a longer prefix or `--source <s>`.

If `--source` is omitted on a resume, sessionr loads the session once to learn the source from metadata, then spawns the right binary.

## NEW session safety

```bash
sessionr send --new -s claude -f prompt.md --dry-run --output json
```

`--dry-run` prints the resolved spawn command WITHOUT running it:

```jsonc
{
  "ok": true,
  "result": {
    "dry_run": true,
    "source": "claude",
    "cwd": "/Users/.../this-project",
    "command": { "bin": "claude", "args": ["-p", "..."] },
    "would_spawn": "claude -p \"...prompt body...\""
  }
}
```

ALWAYS run `--dry-run` before the real command if:
- the prompt is dynamically constructed (you can verify it's not garbled),
- you're in a loop (so you don't fan out N child processes accidentally),
- the spawned tool isn't free (claude / gpt-5 etc.).

After dry-run is clean, drop `--dry-run` and re-issue.

## What `send` actually does

1. Resolves source (from session metadata or `--source`).
2. Builds the upstream invocation. See `references/sources.md` for the per-source resume command shape.
3. Spawns the binary with the prompt.
4. SYNC: drains the child's stdout/stderr to the parent's stderr (so you see live progress without polluting the JSON envelope on stdout). Captures the last 50 lines of each for the error path.
5. ASYNC: detaches the child, writes a `<job_id>.exit` sidecar via a `bash -c` wrapper so the real exit code is captured even after the parent has exited.

## Job lifecycle

| Status | Meaning |
|---|---|
| `running` | child PID is alive, no `<job>.exit` file yet |
| `completed` | exit code 0 |
| `failed` | exit code non-zero, OR PID dead and no `.exit` file (best-effort: `exit_code: -1, last_error: "exit_code_missing"`) |
| `cancelled` | `sessionr cancel` SIGTERM'd the child; exit code 130 |

Job records live under `~/.sessionreader/jobs/<job_id>.json` (metadata) + `<job_id>.stdout`/`<job_id>.stderr` (captured streams) + `<job_id>.exit` (real exit code on terminal).

## Wait + read pattern

```bash
JID=$(sessionr send <id> -m "go" --async --output json | jq -r .data.job_id)
sessionr wait "$JID" --timeout 600 --output json
# wait returns the final job state, plus actions[] with the read-back command
NEXT=$(sessionr job "$JID" --output json | jq -r '.actions[] | select(.description == "Read new messages") | .command')
eval "$NEXT"
```

The `read_back` field on the job record carries the original `--source/--tokens/--preset` so the read-back command preserves the request shape from the original send.

## Cancel

```bash
sessionr cancel <job_id>
```

SIGTERM the child. Status flips to `cancelled`, exit_code becomes 130. The `.exit` sidecar will reflect this if the child handled SIGTERM gracefully; otherwise the parent records 130 directly.

After cancel: `~/.sessionreader/jobs/<job_id>.stderr` has whatever the tool printed before being killed — useful for debugging hangs.

## Timeout

```bash
sessionr wait <job_id> --timeout 60
```

Default 300s. On timeout: exit 1 (`JOB_TIMEOUT`), `retry: true`, `suggestion: "sessionr wait <id> --timeout <2x>"`. The job continues running; you can wait again or cancel.

The suggestion caps at 1 hour to prevent runaway doubling.

## Per-source resume invocation

See `references/sources.md` for the full table. Highlights:

- **claude / codex / gemini / cursor-agent / opencode / commandcode / goose**: take session id explicitly.
- **copilot**: takes `--resume=<id>` with `=` syntax.
- **kiro**: refuses (`UNSUPPORTED_OPERATION`) — no per-session targeting.
- **zed**: refuses (`UNSUPPORTED_SOURCE`) — GUI-only.
- **factory** (alias `droid`): `droid exec [-s <id>] "$msg"`.

If you're driving an agent that emits a `next_action.direct` field on `read` envelopes, that's the verbatim shell command to invoke (not via sessionr) — use it when sessionr's spawn would add overhead you don't want.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `TOOL_ERROR` exit 1 | spawned binary exited non-zero | `error.detail.stderr_tail` shows what it said; common: bad credentials, expired token, network down |
| `SPAWN_ERROR` exit 1 | binary not on PATH | `sessionr doctor` will report `spawn_bin_resolvable: false` for that source |
| `NEW_SESSION_NOT_DETECTED` exit 10 (PARTIAL) | tool exited but no new session file appeared in cwd within ~2s | sleep 1s, then `sessionr list --cwd current --source <s> -n 5` to find it; the file may have flushed late |
| `UNSUPPORTED_OPERATION` exit 2 | trying to resume a kiro session | use `sessionr send --new -s kiro -m "..."` instead |
| `UNSUPPORTED_SOURCE` exit 2 | trying to send to zed | zed is GUI-only; use a CLI source |
| `JOB_TIMEOUT` exit 1 | wait exceeded `--timeout` | wait again with `--timeout <2x>` or cancel; check `<job>.stderr` |

## Concurrency notes

- Multiple `send` invocations against the SAME session id will race — the upstream tool decides what happens (most reject concurrent resume).
- Multiple `--async` jobs are fine; `~/.sessionreader/jobs/` is keyed by job_id.
- `sessionr jobs --output json` lists everything; `--status running` for live ones.

## Don't loop `--new`

Without supervision, `sessionr send --new -s claude -f prompt.md` in a loop creates one new session per iteration AND consumes API credits per iteration. There's no rate limit. Always `--dry-run` first; if you genuinely want N parallel new sessions, use `orchestrate-codex` (for codex) or a comparable per-tool batch driver.
