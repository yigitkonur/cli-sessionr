---
name: use-sessionr
description: Use skill if you are listing, reading, searching, resuming, or pruning AI coding sessions via the sessionr CLI — `sessionr list/read/search/info/stats/doctor/send/job/wait/cancel/context/diff/tag/prune` across claude, codex, gemini, copilot, cursor-agent, commandcode, goose, opencode, kiro, zed, factory/droid sources. Triggers on "find sessions", "what did Claude do yesterday", "resume session abc123", "session of another agent", a UUID-shaped session id pasted in chat, npx sessionr, or any inspect/replay/handoff/cleanup of an AI coding-tool transcript.
---

# Use sessionr

Agent-first interface to AI-coding-tool session transcripts via the `sessionr` CLI (npm: `sessionr`, `npx sessionr`). One zero-install command surfaces every Claude / Codex / Gemini / Copilot / cursor-agent / commandcode / goose / opencode / kiro / zed / factory(droid) session on the local machine, with token-budgeted reads, ETag polling, structured JSON envelopes, and a write path back into the underlying tools.

Use this skill **before** reaching for `cat ~/.claude/projects/...jsonl`, `find ~/.codex -name '*.jsonl'`, `grep -r` against session files, or hand-rolling a parser. Sessionr already does that, normalizes 11 different on-disk formats into one envelope, and emits agent-ready JSON.

## When To Use

*Trigger on any of these tells:*

- *user pastes a session-id-shaped string (8-char prefix or full UUID) — `2d9100c7`, `135e0b78-0388-479f-82db-9de7b1a93d21`, `019e2767`, `019e2183`*
- *user invokes `sessionr`, `npx sessionr`, or any of: `list`, `read`, `search`, `send`, `info`, `stats`, `doctor`, `context`, `diff`, `tag`, `prune`, `jobs`, `job`, `wait`, `cancel`*
- *user asks "what did <Claude / Codex / Gemini / agent / coding tool> do <recently / yesterday / on this project>"*
- *user wants to inspect, replay, or hand-off an AI coding session — "read that session", "show me the prompt I gave Claude in /repo", "what tools were used"*
- *user wants to resume an existing AI coding session by sending a follow-up message — "send another prompt to that session", "ask Codex again on session X"*
- *user wants to discover sessions for the current working directory — "sessions for this repo", "what's been worked on here"*
- *user wants to search across many sessions for a phrase — "find sessions where I asked about X", "which session mentioned <error>"*
- *user wants to compare or diff two sessions, export a session as context for handoff to another agent, or prune old sessions*
- *user is debugging why a session source isn't visible — runs or asks about `sessionr doctor`*
- *agent itself needs to read its own prior session or another agent's session to recover state, continue work, or cite evidence*

**Do NOT use when:**

- *user is asking about HTTP sessions, login sessions, browser sessions, or DB session pooling* — different domain, no overlap
- *user wants to start a brand-new conversation in Claude/Codex/etc.* — they should run that tool directly, not through `sessionr send`
- *user is editing the sessionr CLI itself* (the codebase at `cli-sessionr/`) — that's `do-debug`, `init-agent-config`, or normal coding work
- *user is asking about MCP servers, the Claude API SDK, or Anthropic SDK directly* — route to `claude-api`, `build-mcp-server-sdk-v1/v2`, or `optimize-agentic-mcp`
- *the data needed lives only in a paid hosted service (Linear, GitHub Issues, Slack)* — route to `use-linear-cli`, `gh issue`, or the relevant vendor skill

## Non-negotiable rules

1. **`--output json` for every machine read.** TTY mode emits colored prose; JSON mode emits `{api_version, sessions|messages|jobs|..., meta, cursor?, actions, error?}`. Pipe-aware programs MUST set `--output json` (or set `SESSIONR_OUTPUT=json` for the session). Never grep the human format.
2. **Cwd-aware by default.** `sessionr list` defaults to `--cwd auto` — surfaces sessions for `$PWD` first, falls back to global if none match. Pass `--cwd current` to enforce strict, `--cwd all` to disable filtering, `--cwd <abs-path>` to scope explicitly. Always state which mode you're in.
3. **Resolve before you read.** Session IDs accept any unique prefix (typically 8 chars) — but if the prefix matches multiple sessions in different cwds, the error envelope returns `detail.prefix_matches`. Use `sessionr list -q "<phrase>"` or `sessionr search -q "<phrase>"` to disambiguate; do not retry-loop on `SESSION_NOT_FOUND`.
4. **Honor the exit-code map** (full taxonomy in `references/error-taxonomy.md`):
   - `0` ok · `1` internal · `2` validation/usage · `3` not-found · `4` auth (reserved) · `5` rate-limited (reserved) · `10` PARTIAL (truncated by token budget — `meta.partial=true`, paginate or raise `--tokens`) · `42` NO_CHANGES (`--if-changed` etag matched).
5. **Read with a token budget.** `read` defaults to 8K tokens; pass `--tokens N` to control it. Combine with `--anchor head|tail|search`, `--page N`, or `--before/--after <index>` to navigate. Anchor messages (leading system/user run + last assistant) are never char-truncated regardless of preset (v2.8.1+).
6. **Poll with ETag.** For any "watch this session" loop, capture `meta.etag` from the first read, then `sessionr read <id> --if-changed <etag>` — exit 42 + `{unchanged:true, etag}` envelope when nothing changed. Do not bare-poll `read` in a tight loop.
7. **Send is destructive — gate it.** `sessionr send` spawns the upstream tool (claude/codex/gemini/etc.) and consumes the user's API budget. Use `--dry-run` to preview the spawn command. `--async` returns a `job_id` immediately; pair with `sessionr wait <job_id>` then `sessionr read <session_id> --after <N>` to read the deltas.
8. **`prune --yes` is currently `NOT_IMPLEMENTED`.** It refuses with a structured error rather than fake-deleting. Use `--dry-run` to preview the cutoff list (the only working mode today).
9. **`actions[]` is the next-action menu.** Every JSON envelope ends with `actions: [{command, description}]`. Treat it as the recommended-next-step API. `meta.next_action` (when present) is the single primary recommendation.
10. **When in doubt, run `sessionr doctor`.** Empty list, missing source, `SESSION_NOT_FOUND` on a known ID — the doctor command reports per-source data-dir existence, session count, and whether the resume binary (`claude`, `codex`, …) is on PATH.

## Quick orientation

| Concept | What an agent must know |
|---|---|
| Install | Zero install: `npx sessionr ...`. The CLI auto-detects `npx` and emits `npx sessionr` in `actions[]` accordingly. |
| Sources | 11 backends: `claude`, `codex`, `gemini`, `copilot`, `cursor-agent`, `commandcode`, `goose`, `opencode`, `kiro`, `zed`, `factory` (alias: `droid`). Aliases: `cc`→claude, `cli`/`copilot-cli`→copilot, `cx`→codex, `gm`→gemini. See `references/sources.md`. |
| Default scope | `--cwd auto` ranks $PWD-matching sessions first, falls back to global. `--cwd current` strict. `--cwd all` disables. `--cwd /abs/path` explicit. |
| JSON envelope | `{api_version, sessions[]|messages[]|jobs[], meta:{cwd_scope, cwd, etag?, next_action?, search?, warnings?}, cursor:{next, prev, first}, actions:[{command, description}], error?}`. Full shape: `references/json-envelope.md`. |
| Token budget | `read --tokens N` (default 8K, max ~8K). On truncation: exit 10, `meta.partial=true`, `meta.has_more_after=true`. Iterate via `--page N` or `--before/--after <idx>`. |
| Anchors | First contiguous system/user run from message #1 + the LAST assistant message — never char-truncated regardless of preset. Means initial prompt + final answer always render in full. |
| Presets | `minimal` (~200 tok) · `standard` (~600 tok) · `verbose` (~1500 tok) · `full` (~3000+ tok). Default: `verbose` for agents (non-TTY), `standard` for TTY. |
| ETag | `read` returns `meta.etag` (hash of session content + preset + budget + slice). Pass `--if-changed <etag>` to short-circuit; exit 42 + `{unchanged:true}` envelope on match. |
| `next_action` | Single recommended next command, present on `read`/`info`/`list` envelopes. `actions[]` is the full menu. |

## Five-phase workflow

```
   1. Discover ──► 2. Inspect ──► 3. Read ──► 4. Refine ──► 5. Resume
   (list/search)   (info/stats)   (read)      (search/diff) (send + jobs)
```

### 1. Discover

```bash
sessionr list --output json                         # auto-cwd-scoped
sessionr list claude --output json                  # source-filtered
sessionr list -q "deploy script" --output json      # search content (50-session cap; --max-sessions to widen)
sessionr list --cwd current --output json           # strict $PWD
sessionr list --cwd all --output json               # global, no scope
```

If `sessions[]` is empty → run `sessionr doctor --output json`. Patterns + JSON shape: `references/workflows/discover.md`.

### 2. Inspect (cheap)

```bash
sessionr info <id> --output json     # cheap: id, source, cwd, model, total_messages, tokens
sessionr stats <id> --output json    # full: tool frequencies, files modified, by-role breakdown
```

`info` parses the session once and returns metadata only. `stats` does the full normalization. Prefer `info` first for triage.

### 3. Read

```bash
sessionr read <id> --output json                              # head, default 8K budget, verbose preset
sessionr read <id> --anchor tail --output json                # final messages
sessionr read <id> --search "error" --output json             # window centered on first match
sessionr read <id> --page 2 --tokens 4000 --output json       # paginate
sessionr read <id> --before 50 --output json                  # everything before message #50
sessionr read <id> --role tool_use,tool_result --output json  # role-filtered slice
sessionr read <id> --if-changed <etag> --output json          # 304-style polling
sessionr read <id> -p minimal --include-summary               # per-page session summary on
sessionr read --batch ids.txt --output jsonl --tokens 1000    # streaming JSONL across many sessions
```

Anchor messages (leading system/user run + last assistant) are full-fidelity regardless of preset. Pagination + ETag mechanics: `references/workflows/read.md`.

### 4. Refine

```bash
sessionr search -q "<phrase>" --output json                   # ranked snippets across sessions
sessionr search -q "<phrase>" --max-sessions 200 --output json # deeper scan
sessionr diff <id1> <id2> --output json                       # structural diff (message-level)
sessionr context <id> --tokens 8000 --output json             # extract handoff-ready context
```

### 5. Resume (write path)

```bash
sessionr send <id> -m "follow-up prompt"            # sync; spawns underlying tool, waits, returns deltas
sessionr send <id> -f prompt.md                     # same, prompt from file
sessionr send <id> -m "x" --async                   # returns job_id immediately
sessionr wait <job_id>                              # block until terminal
sessionr job <job_id> --output json                 # poll status
sessionr cancel <job_id>                            # SIGTERM the child
sessionr send --new -s claude -f prompt.md          # NEW session in $PWD (use --dry-run first)
sessionr send <id> --dry-run --output json          # preview the spawn command without running it
```

Job records persist under `~/.sessionreader/jobs/`. Async exit codes are real (sidecar `<job>.exit` file). Mechanics + cancel/timeout: `references/workflows/resume.md`.

## Decision rules

- **"Find / show / list / what sessions" + a project context** → `list --cwd current` (strict) or `list --cwd auto` (default; $PWD first, fall back to global).
- **"Find sessions about X"** → `list -q "X"` (cap-50 quick scan) OR `search -q "X" --max-sessions 200` (deeper, ranked snippets). Prefer `search` for >20 sessions.
- **"Tell me about session <id>"** → `info <id>` first (cheap). Only `stats <id>` when the user asks for tools/files/durations.
- **"Read / show / open the session"** → `read <id>`. Default `--anchor head`. If user says "what was the final answer" → `--anchor tail`. If user references a phrase → `--anchor search --search "<phrase>"`.
- **"Watch / poll for new messages in session"** → first `read <id>` to capture `meta.etag`, then `read <id> --if-changed <etag>` in a loop with backoff. Exit 42 = no change.
- **"Resume session" / "send another message"** → `send <id> -m "..."` (sync) for short replies; `send <id> -m "..." --async` (then `wait`) for anything that will take >30s.
- **"Start a new session in this project"** → `send --new -s <source> -f prompt.md --dry-run` first to verify the spawn command, then drop `--dry-run`. NEVER loop `send --new` (no rate limit).
- **"Compare what these two sessions did"** → `diff <id1> <id2>` for structural; or read both and diff manually if you need text.
- **"Hand off this session's context to another agent / tool"** → `context <id> --tokens 8000` returns a portable summary + filtered messages.
- **"Why is the list empty / where are my Claude sessions"** → `sessionr doctor` (per-source data-dir + binary check). Don't guess; the diagnostic is one command.
- **Unknown source name (`claud`, `gpt`, `gpt-5`)** → returns `INVALID_SOURCE` exit 2 with `detail.valid` listing the 11 supported sources. Use the alias map (`cc`/`cli`/`cx`/`gm`) when the user types shorthand.

Full ranked recipes (10+ multi-step patterns): `references/recipes.md`.

## Output contract

When invoking sessionr from inside a prompt response, always:

1. Run with `--output json` (never grep human format).
2. Capture exit code; branch on the taxonomy (rule #4 above).
3. Surface `meta.next_action.command` to the user when present — it's the recommended next-step.
4. Surface `meta.warnings[]` when present — adapter-level errors (e.g. zstd missing for `zed`) get hoisted here.
5. On `SESSION_NOT_FOUND` (exit 3), check `error.detail.prefix_matches` for ambiguity; surface it instead of "session not found".
6. On `PARTIAL` (exit 10), tell the user "this is a partial slice; paginate" and quote `meta.cursor.next`.
7. Quote source data dirs from `sessionr doctor` when explaining empty results — never invent paths.

## Reference routing

| File | Read when |
|---|---|
| `references/commands.md` | Need full flag/argument shape for any of the 15 commands. |
| `references/json-envelope.md` | Parsing or producing `meta`, `cursor`, `actions`, `error`, ETag, `next_action` shapes. |
| `references/sources.md` | Mapping a source name to its on-disk format / data dir; deciding which source can be resumed; alias resolution. |
| `references/error-taxonomy.md` | Branching on exit code / `error.code` / `retryable`; what each code means and the recommended recovery. |
| `references/workflows/discover.md` | Cwd scoping, source filtering, list-vs-search trade-offs, how the 50-session cap fires. |
| `references/workflows/read.md` | Token budget mechanics, anchor/preset/page/ETag interactions, pagination patterns, batch-read. |
| `references/workflows/resume.md` | Sync vs async send, job lifecycle, exit-code propagation, cancel/timeout, NEW-session safety. |
| `references/recipes.md` | Common multi-step recipes — "find then read", "watch for new messages", "search-deep then diff", "handoff context to fresh agent". |
| `references/troubleshooting.md` | Empty list, ambiguous prefix, source-not-installed, prune-noop, unicode/cwd corner cases, version drift. |

## Guardrails and recovery

- Do not bare-loop `read` for change detection — use `--if-changed <etag>`.
- Do not call `sessionr send --new` in any auto-loop without `--dry-run` first; it spawns paid tools.
- Do not trust `prune --yes` to actually delete; it returns `NOT_IMPLEMENTED` since v2.7.1. Use `--dry-run` only for now.
- Do not parse the human (TTY/text) format with grep/awk — use `--output json`.
- Do not assume a session id is unique without `--source` qualification when the prefix is short (<8 chars).
- Do not pipe `read` of a 100k-message session without `--tokens` — it'll OOM. Always cap.

Recovery moves:

- **Empty list**: `sessionr doctor --output json`. If `data_dir_exists: false` for the source the user expected, that tool hasn't been used here yet.
- **`SESSION_NOT_FOUND` with ambiguous prefix**: re-run with `--source <s>`, OR pass a longer prefix, OR use `sessionr list -q "<phrase>"` to find by content.
- **`PARTIAL` (exit 10)**: paginate. Use `meta.cursor.next` directly. Or raise `--tokens` (capped at 8K).
- **`send` exits non-zero**: read `error.detail.stderr_tail` (last 50 lines from the spawned tool).
- **`send --async` job stuck `running`**: `sessionr cancel <job_id>` then inspect `~/.sessionreader/jobs/<id>.stderr`.
- **Adapter warning** (`meta.warnings[]`): the adapter rejected; surface to user with the adapter name and reason. Don't silently drop.
