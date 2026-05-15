# Sources — 11 backends

Sessionr discovers AI-coding-tool sessions from these on-disk locations. Use `sessionr doctor --output json` to verify any source's state on the current machine.

| Source name | Aliases | On-disk format | Default data dir | Resume binary | Resume invocation |
|---|---|---|---|---|---|
| `claude` | `cc` | JSONL (one event per line) | `~/.claude/projects/*/UUID.jsonl` | `claude` | `claude -p -r <id> "$msg"` |
| `codex` | `cx` | JSONL | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex` | `codex exec resume <id> "$msg"` |
| `gemini` | `gm` | JSON (single doc) | `~/.gemini/tmp/*/chats/session-*.json` | `gemini` | `gemini -p "$msg" -r <id>` |
| `copilot` | `cli`, `copilot-cli` | YAML + JSONL | `~/.copilot/session-state/<id>/` | `copilot` | `copilot -p "$msg" --resume=<id>` |
| `cursor-agent` | — | JSONL | `~/.cursor/projects/*/agent-transcripts/*.jsonl` | `agent` | `agent -p --resume <id> "$msg"` |
| `commandcode` | — | JSONL | `~/.commandcode/projects/*/*.jsonl` | `cmd` | `cmd -p "$msg" --resume <id>` |
| `goose` | — | SQLite + JSONL | `~/.local/share/goose/sessions/` | `goose` | `goose run --resume --session-id <id> -t "$msg"` |
| `opencode` | — | JSON files (per-session dir) | `~/.local/share/opencode/storage/` | `opencode` | `opencode run -s <id> "$msg"` |
| `kiro` | — | JSON | `~/.kiro/User/globalStorage/kiro.kiroagent/` | `kiro-cli` | refuses (`UNSUPPORTED_OPERATION`) — Kiro CLI cannot target a specific session by id |
| `zed` | — | SQLite + zstd | `~/Library/Application Support/Zed/threads/threads.db` | — (GUI-only) | refuses (`UNSUPPORTED_SOURCE`) — Zed AI threads have no CLI send |
| `factory` | `droid` | JSONL (Anthropic-style content blocks) + sidecar `.settings.json` | `~/.factory/sessions/` | `droid` | `droid exec [-s <id>] "$msg"` |

## Alias resolution

Sessionr accepts the aliases in the table above transparently. Pass `--source cc` and the registry resolves to `claude` before any disk access. Unknown sources return `INVALID_SOURCE` with `error.detail.valid` listing all 11 canonical names.

## Read-only sources

`zed` is read-only for sessionr — Zed's AI threads live in a SQLite database and the app expects them edited only through the GUI. `sessionr send` against a `zed` session id refuses with `UNSUPPORTED_SOURCE` exit 2 (suggestion: use a CLI-based tool).

`kiro` is partially read-only — sessions can be parsed and read, but `sessionr send <kiro-id>` refuses with `UNSUPPORTED_OPERATION` because the `kiro-cli` binary cannot target a specific session by id (it always resumes "the most recent session in cwd"). Use `sessionr send --new -s kiro -m "..."` if you want a fresh kiro session.

## Source detection from disk

Each adapter's `find()` method walks its data directory(ies) and returns `SessionListEntry[]`. Failures (e.g. `node:sqlite` unavailable for goose on Node ≤ 21, `zstd` missing for zed) surface as `meta.warnings[]` on `list`/`search`/`read` envelopes — the rest of the discovery still completes.

## Per-source quirks

- **`claude`**: project dir is `~/.claude/projects/-<dashified-cwd>/<UUID>.jsonl`. The cwd encoding maps `/` → `-`, so `~/dev/repo` becomes `~/.claude/projects/-Users-<u>-dev-repo/`. Sessionr decodes the cwd back to absolute path.
- **`codex`**: rollout files are date-partitioned. `--cwd` filtering is reliable because each rollout records the cwd in its first event.
- **`gemini`**: stored as one JSON file with all turns. Token usage is reported per turn but cumulative.
- **`copilot`**: per-session directory with a YAML manifest + JSONL turns. Most agent-relevant data is in the JSONL.
- **`goose`**: SQLite-backed; requires `node:sqlite` (Node 22.5+). On older Node the source emits a warning and returns 0 sessions.
- **`opencode`**: each session is a directory with metadata.json + messages/*.json files. Sessionr reads them in lexical order.
- **`kiro`**: JSON dump from VS Code's globalStorage; format changes with kiro extension version. Parser is best-effort.
- **`zed`**: SQLite database with zstd-compressed message bodies. Requires the `zstd` system binary (or `node:sqlite` for the Sqlite read).
- **`factory`** (`droid`): Anthropic-style content blocks → reuses `src/parsers/explosion.ts`. Tokens come from a sidecar `.settings.json`. ApplyPatch file changes extracted via the `*** Add|Update|Delete File:` regex.

## "I expected this source to show up but didn't"

Run `sessionr doctor --output json | jq '.result.sources[] | select(.session_count == 0 or .data_dir_exists == false)'` — that filters to sources with no sessions on disk. If a source you've definitely used reports `session_count: 0`, the data dir may have moved (e.g. if the user is on `~/Library/Application Support/...` and the tool now writes to `~/Documents/...`).

## Adding a new source

If the user mentions a tool sessionr doesn't know — see the project's `AGENTS.md` "Adding a New Parser" section. The agent should not invent a source mapping; route to the development workflow instead.
