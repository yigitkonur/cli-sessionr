# Migrating to sessionr v4

v4 keeps the v2 JSON envelope from v3 untouched. What changes is how `read` pages
through a session and what `stats` counts, because both were quietly wrong for agents
that loop over a session. If you only read sessions interactively you will barely
notice. If you page with `--after` / `--before`, or reconcile `stats.by_role` against
`total_messages`, read this.

## Breaking changes

### 1. `--after N` and `--before N` are strictly exclusive

| | v3 | v4 |
|---|---|---|
| `--after N` | messages with index `>= N` (re-read `N`) | messages with index `> N` |
| `--before N` | messages with index `<= N` | messages with index `< N` |

`meta.cursor_after` is now the index of the last message returned and `meta.cursor_before`
the index of the first, so `meta.cursor.next.command` (`--after <last>`) and `cursor_after`
agree and following the advertised cursor never repeats a message. In v3 they differed by
one, so a loop that followed the printed command re-read the boundary message forever.

- `--after 0` is accepted.
- A cursor past either end (`--after <total>`, `--before 1`) returns an empty slice
  (`messages: []`, exit 0) instead of `INVALID_RANGE`, so polling does not need a special case.
- With no `--anchor`, `--before` defaults to `tail` and `--after` to `head`.

**Migrate:** if you passed `--after N` meaning "from N", pass `--after N-1`.

### 2. `stats.by_role.user` counts human prompts only

Slash commands (`/model`), interrupts (`[Request interrupted by user]`), system preambles
and task notifications are no longer counted as user prompts. Prompts absorbed mid-turn
(queued steers from a human) are counted. As a result `by_role` no longer has to add up to
`total_messages`: on real Claude sessions that contain slash commands or interrupts the gap
is exactly the number of those messages.

**Migrate:** use `total_messages` for the message count; use `by_role.user` for "how many
times did a human prompt".

### 3. `partial` and exit code 10 mean "the token budget cut the slice you asked for"

`read <id> 1 2 --tokens 8000` on a longer session now exits 0 with `partial: false`
(`has_more_after: true` still tells you there is more). Exit 10 is reserved for real
budget truncation. A search with no match reports `meta.search.matched: false` with no
messages instead of silently returning the tail.

## Additions you can rely on

- **Turns:** `read <id> --turn <n|turn-n|last>`; `meta.turn` and `meta.turns` carry the
  prompt, files changed, commands with exit codes, error count, duration, token usage,
  context window and reasoning effort. Sessions that start from a slash command and never
  get a human prompt have no turns.
- **Messages:** `source` (`prompt`, `queued`, `system`, `local_command`, `interrupt`,
  `task_notification`, `injected`), `origin_kind`, `kind`, and a `raw_line_index` that is
  the physical line in the file.
- **Pending tool calls:** `result.pending_tool_calls`, `meta.pending_tool_call_count` and
  `meta.pending_tool_call_ids`. A trailing unanswered tool call is never trimmed away.
- **Compaction:** one `system` message per compaction (`kind: "compaction"`) and
  `stats.compactions`. The summary text is emitted only at `--preset full`.
- **Search:** `--search-in content,tool_input,tool_result`.
- **Antigravity CLI (`agy`):** new source, `sessionr list agy`.
- **Library:** `import { read, getStats, loadSessionByPath, registerSource, getAdapter, getAdapters } from "sessionr"`.
  `read()` returns normalized messages unrendered, so its token budget is measured on what
  it returns and `preset` does not change them; `page` is rejected with `UNSUPPORTED_OPTION`
  (page with `after` / `before`). Goose and OpenCode sessions can only be loaded by path
  from inside their own store (`SOURCE_STORE_PATH_REQUIRED` otherwise).
- **Codex forks:** a forked Codex session now reports its own id instead of its parent's, so
  the cursor commands it prints point at the right session.

---

# Migrating from v2 to sessionr v3

v3 is a **hard break** focused on one thing: making every command emit a single,
predictable JSON envelope that an LLM agent can parse without per-command special
casing. If you only ever ran `sessionr` interactively in a terminal, you will
barely notice. If you script against `--output json`, read this.

## The one big change: the v2 envelope

Every command now returns the same top-level shape.

**Success:**

```json
{
  "ok": true,
  "schema_version": "v2",
  "result": { "...command-specific payload..." },
  "meta": { "...pagination / etag / cwd / timing..." },
  "actions": [ { "command": "...", "description": "..." } ]
}
```

**Failure:**

```json
{
  "ok": false,
  "schema_version": "v2",
  "error": {
    "class": "validation | not_found | auth | rate_limit | internal | partial",
    "code": "SESSION_NOT_FOUND",
    "message": "Session not found: deadbeef",
    "detail": { "...": "..." },
    "suggestion": "sessionr list --cwd current",
    "retryable": false
  }
}
```

One parser for the whole CLI:

```js
const resp = JSON.parse(stdout);
if (!resp.ok) handle(resp.error); else use(resp.result);
```

### What moved

| v2.x | v3 |
|---|---|
| `{ api_version: 1, sessions: [...] }` (list) | `{ ok, schema_version, result: { sessions: [...] }, meta: { cwd_scope, ... } }` |
| `{ api_version: 1, messages: [...], session, meta }` (read) | `{ ok, schema_version, result: { session, messages }, meta }` |
| flat fields at root (info / stats) | `result: { session: { ... } }` |
| `{ api_version: 1, data: { ... } }` (send / job) | `{ ok, schema_version, result: { ... } }` — the `data` wrapper is gone |
| `{ error: { code, message, retry } }` | `{ ok: false, schema_version, error: { class, code, message, detail?, suggestion?, retryable } }` |

Note: the error field `retry` is now **`retryable`**, and every error carries a
**`class`**.

### Field naming

Every key in the JSON envelope is **snake_case**, and so are enum values:

- `by_role.tool_use` / `by_role.tool_result` (was `byRole.toolUse` / `toolResult`)
- `token_usage.cache_read` / `cache_creation` (was `cacheRead` / `cacheCreation`)
- `files_modified`, `duration_ms`, `git_branch`, `created_at`, `updated_at`, …

The **one exception**: the `input` payload of a `tool_use` block is passed through
**verbatim** — those are arbitrary tool arguments and renaming their keys would
corrupt the call. If a tool was invoked with `{ "maxOutputTokens": 16000 }`, you
read back `{ "maxOutputTokens": 16000 }`.

## Exit codes (unchanged, now used consistently)

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error |
| 2 | Bad usage / validation |
| 3 | Session / job / resource not found |
| 4 | Authentication required (reserved) |
| 5 | Rate-limited / transient (reserved) |
| 10 | Partial result (truncated by token budget) |
| 42 | No changes (`--if-changed` match) |

## New things you can rely on

- **`meta.etag`** is now returned on every `read`. Poll cheaply:
  `sessionr read <id> --if-changed <etag>` → exit 42 + tiny body if unchanged.
  The etag is view-aware (changes with preset / budget / range / anchor / search).
- **Message dedup**: a message carries `content` OR `blocks`, never both.
  `--preset minimal|standard` → flat `content`; `--preset verbose|full` → structured
  `blocks`. Tool-heavy JSONL streams shed ~30–60% bytes.
- **`send --dry-run`**: prints `result.would_spawn { bin, args, cwd }` and exits
  without launching anything. `--max-new-per-run <n>` caps accidental fan-out.
- **`--output` is validated**: `--output xml` (or any typo) → `INVALID_OUTPUT`,
  exit 2, instead of silently dumping text.
- **`--timing`** populates `meta.timing_ms`.
- **`sessionr docs [topic]`**: bundled reference docs, offline.
- **Source aliases**: `cc` → claude, `gpt`/`openai`/`oai` → codex, `droid` → factory.
- **`list` is cwd-aware** by default: `meta.cwd_scope` tells you whether results
  were scoped to the current directory (`auto`), fell back to global
  (`fellback_to_global`), or were explicitly broadened (`all`).

## Behavior changes to know about

- **`prune --yes` refuses** with `NOT_IMPLEMENTED` in v3.0. Real deletion is
  deferred to v3.1 (so the success envelope never lies about destructive action).
  `prune --dry-run` previews what *would* be deleted and works today.
- **`read --anchor search` without `--search`** is now an error
  (`INVALID_ANCHOR_USAGE`) instead of silently behaving like `--anchor tail`.
- **`--tokens 0`** is rejected (`INVALID_RANGE`) instead of silently disabling
  paging.
- **`--role <badname>`** now returns `INVALID_ROLE` (was a misleading
  `INVALID_RANGE`).
- The legacy nested `sessionr session <cmd>` aliases still work but print a
  deprecation warning; use the flat `sessionr <cmd>` form.

## If you used the `--json` flag

`--json` still works but is deprecated and warns on stderr. Switch to
`--output json` (or `--output jsonl`).
