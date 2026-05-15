# Error taxonomy & exit codes

Every command exits with a semantic code. JSON-mode errors land on **stdout** as `{error:{...}}`; text-mode errors land on stderr. Both carry the same payload.

## Exit codes (contract)

| Code | Name | Meaning | Agent action |
|---|---|---|---|
| 0 | OK | success | continue |
| 1 | ERROR | internal / unhandled | parse `error.code` if present; surface to user |
| 2 | USAGE | validation / bad args | fix the command; do not retry blindly |
| 3 | NOT_FOUND | session/job/resource missing | check `error.detail.prefix_matches`; route to `list`/`doctor` |
| 4 | AUTH | reserved (auth class) | not currently emitted |
| 5 | RATE_LIMITED | reserved (transient class) | not currently emitted |
| 10 | PARTIAL | valid response, truncated by token budget | check `meta.partial=true`, paginate via `meta.cursor.next` |
| 42 | NO_CHANGES | `--if-changed <etag>` matched | session unchanged since etag; treat as no-op |

The PARTIAL exit is **not** a failure. The response body is valid JSON; the agent should accept it AND know there's more.

## Error codes (the `error.code` enum)

Per command boundary class. Documented codes you'll see in production:

### Validation (exit 2 / USAGE)

| Code | Where | What it means |
|---|---|---|
| `INVALID_SOURCE` | any command with `--source` | Source not in the 11 known names. `detail.valid` lists them. |
| `INVALID_PRESET` | `read --preset` | Preset not in `[minimal, standard, verbose, full]`. |
| `INVALID_ROLE` | `read --role` | Comma-list contained an unknown role. `detail.unknown` + `detail.valid`. |
| `INVALID_ANCHOR` | `read --anchor` | Not in `[head, tail, search]`. |
| `INVALID_ANCHOR_USAGE` | `read --anchor search` | `--anchor search` requires `--search <q>`. |
| `INVALID_TOKEN_BUDGET` | `read --tokens` | `--tokens <= 0` rejected. |
| `INVALID_DURATION` | `prune --older-than` | Not `Nd|Nh|Nm|Ns` form, or value `<= 0`. |
| `INVALID_ARG` | `list -n / --offset / --top / --max-sessions / --page / --before / --after / --timeout / --interval` | Numeric arg out of range or NaN. |
| `INVALID_OUTPUT_FORMAT` | global `--output` | Not in `[json, jsonl, table, text]`. |
| `MISSING_MESSAGE` | `send` | Neither `-m` nor `-f` given. |
| `MISSING_SOURCE` | `send --new` | `--new` requires `--source`. |
| `MISSING_SESSION` | `send` | Neither session-id nor `--new --source` given. |
| `CONFLICTING_FLAGS` | `send -m ... -f ...` | `--message` and `--file` are mutually exclusive. |
| `FILE_NOT_READABLE` | `send -f` | `--file` path doesn't exist or isn't readable. |
| `USAGE_ERROR` | top-level Commander errors | Unknown flag / unknown command / missing required arg. |

### Not found (exit 3 / NOT_FOUND)

| Code | Where | What it means |
|---|---|---|
| `SESSION_NOT_FOUND` | any command with `<session-id>` | No session matches the id (full or prefix). `detail.prefix_matches[]` if the prefix was ambiguous. |
| `JOB_NOT_FOUND` | `job/wait/cancel` | Job ID has no record under `~/.sessionreader/jobs/`. |
| `SOURCE_UNKNOWN` | `send` | Source could not be auto-detected from session metadata. |

### Internal / runtime (exit 1 / ERROR)

| Code | Where | What it means |
|---|---|---|
| `TOOL_ERROR` | `send` (sync) | Spawned tool exited non-zero. `detail.stderr_tail` (last 50 lines) + `detail.exit_code`. |
| `SPAWN_ERROR` | `send` | Spawn failed (binary not on PATH, etc.). `detail.error`. |
| `JOB_TIMEOUT` | `wait` | Exceeded `--timeout` seconds. `retry: true`. |
| `PARSE_ERROR` | any command (rare) | Adapter could not parse the session file. |
| `UNSUPPORTED_OPERATION` | `send <kiro-id>` | Kiro CLI can't target by id. |
| `UNSUPPORTED_SOURCE` | `send <zed-id>` | Zed has no CLI send. |
| `NOT_IMPLEMENTED` | `prune --yes` | Real deletion not yet implemented (currently refuses). |
| `ADAPTER_FAILED` | `meta.warnings[]` only | One adapter rejected; not a top-level error. Surface to user. |
| `UNKNOWN_ERROR` | fallback | Anything that isn't a SessionReaderError. Should be rare. |

### Partial (exit 10 / PARTIAL)

| Code | Where | What it means |
|---|---|---|
| `NEW_SESSION_NOT_DETECTED` | `send --new` | Tool exited 0 but no new session appeared in cwd within ~2s. `retry: true`. Caller should `sessionr list --cwd current --source <s>` and retry the read. |

The `meta.partial=true` flag on `read` envelopes also carries this class — there's no separate `error.code`, just the exit + meta flag.

### No changes (exit 42 / NO_CHANGES)

| Code | Where | What it means |
|---|---|---|
| (no `error`) | `read --if-changed <etag>` | Session unchanged. Body is `{unchanged: true, etag, meta:{...}}`. |

## Retry semantics (`error.retry`)

Most errors return `retry: false`. The handful that justify a retry:

- `JOB_TIMEOUT` — agent could `wait <id> --timeout <2x>` to keep waiting.
- `NEW_SESSION_NOT_DETECTED` — file may not have flushed yet; one retry after 1s is reasonable.
- `PARSE_ERROR` mid-read — file may be mid-flush from a live writer. Retry once after 1s.

Do **not** retry validation errors (codes starting `INVALID_` or `MISSING_` or `CONFLICTING_`) — fix the command and re-issue.

Do **not** retry `SESSION_NOT_FOUND` blindly — check `prefix_matches` first.

## Stdout vs stderr discipline

In `--output json|jsonl` mode, the JSON envelope (success **or** error) is on stdout. This means:

```bash
sessionr read deadbeef --output json 2>/dev/null | jq .error.code
# → "SESSION_NOT_FOUND"
```

…works. Don't redirect stderr to stdout for JSON parsing — you risk catching CLI-stack errors that aren't part of the envelope.

In text/TTY mode, errors are on stderr (human-readable, with chalk colors when TTY).

## Known envelope drift

Some commands' envelope shape pre-dates the unification effort. Stable for v2.x but worth documenting:

- **`info` and `stats`** are flat: `{api_version, id, source, ...}` (no `meta` wrapper, no nested `result`).
- **`send` async** wraps under `data`: `{api_version, data: {job_id, ...}, actions}`. Sync `send` uses `meta` at root.
- **`job`/`wait`/`cancel`** wrap under `data`.
- **`jobs`** uses `jobs[]` at root.
- **`prune --dry-run`** uses `would_delete[]` at root.
- **Top-level usage errors** (Commander throws) emit `{error:{code, message, retry}}` only — no `detail`/`suggestion`. This is fixable but ships as-is.

A future `--api-version 2` will unify under `{ok, schema_version, result, meta, error?}`. Today, code defensively against the per-command shape.

## Recovery cheat sheet

| Symptom | First move |
|---|---|
| `error.code == "SESSION_NOT_FOUND"` | inspect `error.detail.prefix_matches`; longer prefix or `--source` qualifier |
| `error.code == "INVALID_SOURCE"` | check `error.detail.valid` for the typo; try the alias map (cc/cli/cx/gm) |
| Empty `sessions[]` from `list` | `sessionr doctor --output json` |
| `error.code == "TOOL_ERROR"` | `error.detail.stderr_tail` shows what the spawned tool printed |
| `error.code == "JOB_TIMEOUT"` | `sessionr wait <id> --timeout <2x>` (cap at 1h) OR `sessionr cancel <id>` and inspect `~/.sessionreader/jobs/<id>.stderr` |
| `error.code == "NOT_IMPLEMENTED"` (prune --yes) | use `--dry-run`; do actual deletion manually until release |
| `error.code == "NEW_SESSION_NOT_DETECTED"` | sleep 1s, then `sessionr list --cwd current --source <s> -n 5` to find it |
| Adapter `meta.warnings[]` (`ADAPTER_FAILED`) | surface to user; check `sessionr doctor` for that source's `data_dir_exists` and required-binary status |
| Exit 10 `PARTIAL` | response is valid; paginate via `meta.cursor.next` OR raise `--tokens` (cap 8K) |
| Exit 42 `NO_CHANGES` | session unchanged since etag; nothing to do |
