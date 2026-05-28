# Migrating to sessionr v3

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
