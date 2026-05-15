# Sessionr commands — full surface

15 commands. Every one accepts `--output json|jsonl|text` and respects `SESSIONR_OUTPUT` env var. Always use `--output json` for parseable output.

## Discovery

### `sessionr list [source]`

```
sessionr list [source]
  -n, --limit <n>          Max sessions (default 20)
  --offset <n>             Skip first N (pagination)
  -q, --search <query>     Filter by message content (caps at --max-sessions)
  --max-sessions <n>       Cap content scan (default 50, max 200)
  --cwd <mode>             auto | current | all | <abs-path>  (default: auto)
  --output <fmt>           json | jsonl | text
```

`source` is optional positional: any of the 11 source names or aliases (`cc`/`cli`/`cx`/`gm`).

`--cwd auto` (default): rank `$PWD`-matching entries first, fall back to global if none match.
`--cwd current`: strict — only `$PWD` matches.
`--cwd all`: disable scoping.
`--cwd /abs/path`: explicit path.

JSON envelope shape: `references/json-envelope.md` → "list".

### `sessionr search -q <query>`

Deeper search than `list -q`. Returns ranked snippets with `message_index` + `char_offset`.

```
sessionr search -q <query> [-s <source>] [--top N] [--max-sessions N] [--output json]
```

### `sessionr doctor`

Per-source diagnostic. Reports `data_dir`, `data_dir_exists`, `session_count`, `spawn_bin`, `spawn_bin_resolvable`, `warnings[]`. Use when `list` returns empty.

```
sessionr doctor [--output json]
```

## Inspection

### `sessionr info <id>`

Cheap metadata — id, source, cwd, model, total_messages, by_role, token_usage, duration. No tool list.

```
sessionr info <id> [-s <source>] [--output json]
```

### `sessionr stats <id>`

Full normalization — info + tool frequencies, files modified, message-block breakdown.

```
sessionr stats <id> [-s <source>] [--output json]
```

## Reading

### `sessionr read <session-id> [from] [to]`

```
sessionr read <session-id> [from] [to]
  -s, --source <s>          Source filter (resolves alias)
  -p, --preset <name>       minimal | standard | verbose | full
  -d, --detail <level>      full | condensed | skeleton | meta
  --tokens <n>              Token budget (default 8000, max ~8000)
  --anchor <a>              head | tail | search   (default head)
  --search <query>          Slice around first match (sets anchor=search)
  --role <r1,r2>            user, assistant, system, tool_use, tool_result
  --page <n>                Page number (1-based)
  --before <cursor>         Show messages before this index
  --after <cursor>          Show messages after this index
  --if-changed <etag>       304-style polling
  --include-summary         Include summary on every page (default: page 1 only)
  --batch <path>            Newline-separated IDs → JSONL stream
```

**Anchor messages** (leading system/user run + last assistant) are never char-truncated regardless of preset (v2.8.1+).

`from`/`to` are 1-based message indices when both `--page` and `--before/--after` are absent.

`PARTIAL` exit (10) when token budget truncated the slice — `meta.partial=true`, `meta.has_more_*` set, `meta.cursor.next` ready to copy-paste.

### `sessionr context <session-id>`

Extract handoff-ready context (filtered messages + summary).

```
sessionr context <session-id>
  --tokens <n>              Token budget (default 8000)
  --include-system-prompt   Include system messages
  --include-tool-results    Include tool results
  --format <fmt>            messages | summary
```

### `sessionr diff <id1> <id2>`

Structural diff at message level. JSON-only.

## Write path (resume / new session)

### `sessionr send [session-id]`

```
sessionr send [session-id]
  -m, --message <text>     Inline prompt
  -f, --file <path>        Prompt from file
  -s, --source <source>    Required with --new
  --new                    Create new session instead of resuming
  --async                  Return job_id immediately
  --cwd <dir>              Working directory for the spawn
  --tokens <n>             Read-back token budget
  -p, --preset <name>      Read-back preset (default standard)
  --dry-run                Print resolved spawn command, exit 0
```

Sync (default): blocks, returns `{messages, meta:{message_count_before, new_messages, ...}}` with the freshly-added messages.

Async (`--async`): returns `{job_id, session_id, source, status:"running", pid, ...}` immediately. Pair with:

### `sessionr job <job-id>`

Status snapshot. Reads `<job>.exit` sidecar to determine real exit code.

### `sessionr wait <job-id>`

```
sessionr wait <job-id> [--timeout 300] [--interval 2]
```

Block until terminal (`completed` / `failed` / `cancelled`).

### `sessionr cancel <job-id>`

SIGTERM the child, set status `cancelled` with `exit_code: 130`.

### `sessionr jobs`

List all jobs (running + recent). `--status running|completed|failed|cancelled` to filter.

## Maintenance

### `sessionr prune --older-than <duration>`

```
sessionr prune --older-than <duration>
  --dry-run                Preview what would be deleted (only working mode)
  --yes                    Confirm (currently NOT_IMPLEMENTED — refuses)
  -s, --source <s>         Scope to one source
```

Duration format: `7d`, `24h`, `30m`, `60s`. `0d` is rejected.

⚠ `--yes` returns `{error:{code:"NOT_IMPLEMENTED",...}}` exit non-zero. Use `--dry-run` to inspect the cutoff list; do actual deletion manually until a future release implements adapter-level deletion.

### `sessionr tag <id> --add|--remove <tag>`

Idempotent. Tags are session-global (do not depend on `--source`).

## Top-level / global flags

Apply before the subcommand:

```
sessionr [--output <fmt>] [--api-version <n>] [--timing] <command> ...
```

- `--api-version 1` (default; 2 reserved for future envelope rework).
- `--timing` adds `meta.timing_ms` to every JSON envelope (wall-clock ms).
- Env: `SESSIONR_OUTPUT=json|jsonl|table|text` overrides the default.
- Env: `SESSIONR_AGENT=1` forces JSON regardless of TTY status.

## Help & version

- `sessionr --help` → human help.
- `sessionr --output json help` → JSON help schema (`workflow[]`, `primary_commands[]`, `all_commands[]`, `exit_codes`). Exit 0.
- `sessionr help <subcommand>` → per-command help.
- `sessionr --version` → reads from package.json at install time. Always matches the installed `sessionr@<version>`.

## Removed / changed flags (version drift)

- v2.7.0: `--cwd <scope>` on `list` removed (was a duplicate). Now only `--cwd <mode>`.
- v2.7.1: `program.version()` reads from package.json (was hardcoded — pre-2.7.1 binaries reported wrong --version).
- v2.8.0–v2.8.1: anchor messages (leading system/user run + last assistant) are full-fidelity regardless of preset.
