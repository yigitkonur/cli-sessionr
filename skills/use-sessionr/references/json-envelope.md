# JSON envelope shapes

Every command returns `--output json` as a single top-level object.  Some keys are universal, some per-command.

## Universal keys

```jsonc
{
  "api_version": 1,
  "meta": { /* command-specific metadata */ },
  "actions": [ { "command": "...", "description": "..." } ],
  "error": { /* only on failure */ }
}
```

- `api_version` is always `1` for this release. (`--api-version 2` flag is reserved for a future envelope rework.)
- `meta` carries pagination, scope, etag, next_action, warnings. Per-command shape below.
- `actions` is a list of recommended-next commands the agent can execute or surface. Always check it before inventing your own.
- `error` is only present when the command failed. Format below.

## list

```jsonc
{
  "api_version": 1,
  "meta": {
    "cwd_scope": "auto" | "current" | "all" | "explicit" | "fellback_to_global",
    "cwd": "/Users/.../this-project",
    "search": { /* present when -q given */
      "query": "deploy",
      "sessions_scanned": 50,
      "sessions_available": 412,
      "truncated": true
    },
    "warnings": [ /* present when adapters rejected */
      { "source": "zed", "error": { "code": "ADAPTER_FAILED", "message": "zstd missing" } }
    ],
    "next_action": {
      "command": "sessionr read <id>",
      "description": "Read the most recent matching session"
    }
  },
  "sessions": [
    {
      "id": "135e0b78-0388-479f-82db-9de7b1a93d21",
      "source": "claude",
      "cwd": "/abs/path",
      "updatedAt": "2026-05-15T12:10:43.230Z",
      "summary": "first 100 chars of the first user prompt …",
      "filePath": "/Users/.../session.jsonl",
      "isEmpty": false
    }
  ],
  "total_available": 41,
  "limit": 20,
  "offset": 0,
  "has_more": true,
  "available_sources": ["claude", "codex", "gemini", "...11 total"],
  "cursor": {
    "next": "sessionr list --offset 20 --limit 20",
    "prev": null,
    "first": null
  },
  "actions": [
    { "command": "sessionr read 135e0b78", "description": "Read most recent session" },
    { "command": "sessionr stats 135e0b78", "description": "Full statistics" },
    { "command": "sessionr list --search \"keyword\"", "description": "Search recent" },
    { "command": "sessionr search -q \"keyword\" --max-sessions 200", "description": "Search deeper" },
    { "command": "sessionr send --new -s claude -f prompt.md", "description": "New session" }
  ]
}
```

## read

```jsonc
{
  "api_version": 1,
  "session": { /* SessionSummary; only on page 1 unless --include-summary */
    "id": "...",
    "source": "claude",
    "model": "claude-opus-4-7",
    "cwd": "/abs/path",
    "git_branch": "main",
    "total_messages": 32,
    "total_tokens_estimate": 12450,
    "pages_estimate": 3,
    "duration": "1m 2s",
    "by_role": {"user": 1, "assistant": 1, "system": 0, "tool_use": 15, "tool_result": 15}
  },
  "meta": {
    "session_id": "...",
    "source": "claude",
    "total_messages": 32,
    "total_tokens_estimate": 12450,
    "returned_tokens_estimate": 7842,
    "token_budget": 8000,
    "anchor": "head" | "tail" | "search" | "page",
    "range": { "from": 1, "to": 22 },
    "has_more_before": false,
    "has_more_after": true,
    "cursor_before": null,
    "cursor_after": 23,
    "cursor": {
      "next": "sessionr read <id> --after 22 --tokens 8000",
      "prev": null,
      "first": null
    },
    "page": { "current": 1, "total": 3 },
    "etag": "a3f1e7b9c2d8...",
    "partial": true,                       /* set when slice was truncated */
    "next_action": {
      "resume": "sessionr send <id> -f prompt.md --source claude",
      "resume_async": "sessionr send <id> -f prompt.md --source claude --async",
      "direct": "claude -p -r <id> \"$(cat prompt.md)\"",
      "verified": true,
      "tip": "claude resumes by --resume <id>"
    },
    "detail_hint": {                       /* present when current preset truncated something */
      "current_preset": "standard",
      "hidden_tool_calls": 0,
      "truncated_results": 12,
      "thinking_hidden": false,
      "upgrade_options": [
        { "preset": "verbose", "estimated_tokens": 1500, "command": "sessionr read <id> --preset verbose --tokens 4000" },
        { "preset": "full",    "estimated_tokens": 4200, "command": "sessionr read <id> --preset full --tokens 8000" }
      ]
    }
  },
  "messages": [
    {
      "index": 1,
      "role": "user",
      "timestamp": "2026-05-14T13:29:12.000Z",
      "tokens_estimate": 38,
      "content": "lets check git log of project ...",
      "blocks": [ /* present when blocks add info beyond content */
        { "type": "tool_use", "id": "...", "name": "Read", "input": { "file_path": "..." } },
        { "type": "tool_result", "toolUseId": "...", "content": "...", "isError": false }
      ]
    }
  ],
  "actions": [
    { "command": "sessionr stats <id>", "description": "Full statistics" },
    { "command": "sessionr context <id> --tokens 8000", "description": "Export for handoff" },
    { "command": "sessionr diff <id> <other-id>", "description": "Compare with another session" }
  ]
}
```

### read --if-changed match

When the supplied etag matches the current state — exit 42 (`NO_CHANGES`):

```jsonc
{
  "api_version": 1,
  "unchanged": true,
  "etag": "a3f1e7b9c2d8...",
  "meta": {
    "session_id": "...",
    "source": "claude",
    "total_messages": 32,
    "updated_at": "2026-05-14T13:30:14.000Z"
  },
  "actions": [
    { "command": "sessionr read <id> --if-changed <etag>", "description": "Poll again" },
    { "command": "sessionr read <id>", "description": "Bypass etag and fetch" }
  ]
}
```

## info

Flat shape (no `meta` wrapper today):

```jsonc
{
  "api_version": 1,
  "id": "...",
  "source": "claude",
  "cwd": "~/dev/project",
  "model": "claude-opus-4-7",
  "git_branch": "main",
  "created_at": "...",
  "updated_at": "...",
  "total_messages": 32,
  "by_role": {...},
  "token_usage": { "input": 52677, "output": 2682, "cacheRead": 189952, "thinking": 129 },
  "duration_ms": 62000,
  "actions": [...]
}
```

## stats

Like info but with adapter-level normalized session spread at the top: `metadata`, `stats` (toolFrequency, filesModified, byBlockType, durationMs), `messages` is omitted.

## search

```jsonc
{
  "api_version": 1,
  "query": "...",
  "sessions_scanned": 20,
  "sessions_available": 412,
  "meta": { "warnings": [] },
  "results": [
    {
      "id": "...", "source": "...", "cwd": "...",
      "match_count": 7,
      "matches": [
        { "message_index": 5, "snippet": "...error in token calculation...", "char_offset": 120 }
      ]
    }
  ],
  "total_matches": 3,
  "actions": [...]
}
```

## doctor

```jsonc
{
  "api_version": 1,
  "result": {
    "node_version": "v22.3.0",
    "sessionr_version": "2.8.1",
    "cwd": "/abs/path",
    "sources": [
      {
        "name": "claude",
        "data_dir": "/Users/.../.claude/projects",
        "data_dir_exists": true,
        "session_count": 142,
        "spawn_bin": "claude",
        "spawn_bin_resolvable": true,
        "spawn_bin_path": "/usr/local/bin/claude"
      }
      /* one row per source */
    ],
    "warnings": ["zed: zstd binary not found, zed sessions cannot be parsed"]
  }
}
```

## send (sync)

```jsonc
{
  "api_version": 1,
  "meta": {
    "session_id": "...",
    "source": "claude",
    "total_messages": 35,
    "message_count_before": 32,
    "message_count_after": 35,
    "new_messages": 3,
    "total_tokens_estimate": 13560,
    "returned_tokens_estimate": 1110,
    "range": { "from": 33, "to": 35 },
    "is_new_session": false
  },
  "messages": [ /* only the NEW messages (after message_count_before) */ ],
  "actions": [
    { "command": "sessionr read <id> --after 32 --source claude", "description": "Re-read new messages" }
  ]
}
```

## send (async)

```jsonc
{
  "api_version": 1,
  "data": {
    "job_id": "j-2026...",
    "session_id": "...",
    "source": "claude",
    "status": "running",
    "pid": 58242,
    "started_at": "2026-05-15T13:00:01.037Z",
    "is_new_session": false,
    "message_count_before": 32
  },
  "actions": [
    { "command": "sessionr job j-2026...", "description": "Check job status" },
    { "command": "sessionr wait j-2026...", "description": "Wait for completion" },
    { "command": "sessionr cancel j-2026...", "description": "Cancel job" }
  ]
}
```

## job / wait / cancel

```jsonc
{
  "api_version": 1,
  "data": {
    "job_id": "j-2026...",
    "session_id": "...",
    "source": "claude",
    "status": "running" | "completed" | "failed" | "cancelled",
    "pid": 58242,
    "exit_code": 0,
    "started_at": "...",
    "completed_at": "..." | null,
    "is_new_session": false,
    "read_back": { "source": "claude", "tokens": 4000, "preset": "verbose" }
  },
  "actions": [...]
}
```

## error envelope

```jsonc
{
  "error": {
    "code": "SESSION_NOT_FOUND" | "INVALID_SOURCE" | "INVALID_PRESET" | "INVALID_ROLE"
          | "INVALID_ANCHOR" | "INVALID_ANCHOR_USAGE" | "INVALID_TOKEN_BUDGET"
          | "INVALID_DURATION" | "INVALID_ARG" | "INVALID_OUTPUT_FORMAT"
          | "MISSING_MESSAGE" | "MISSING_SOURCE" | "MISSING_SESSION"
          | "CONFLICTING_FLAGS" | "FILE_NOT_READABLE" | "USAGE_ERROR"
          | "NEW_SESSION_NOT_DETECTED" | "TOOL_ERROR" | "SPAWN_ERROR"
          | "JOB_NOT_FOUND" | "JOB_TIMEOUT" | "UNSUPPORTED_OPERATION"
          | "SOURCE_UNKNOWN" | "PARSE_ERROR" | "NOT_IMPLEMENTED"
          | "ADAPTER_FAILED" | "UNKNOWN_ERROR",
    "message": "Session not found: deadbeef",
    "detail": {
      "session_id": "deadbeef",
      "cwd": "/Users/...",
      "prefix_matches": [ /* present when prefix matches >1 session */
        { "id": "...", "cwd": "...", "source": "..." }
      ],
      "stderr_tail": "..."        /* present on TOOL_ERROR */
    },
    "suggestion": "sessionr list --cwd current  (or --cwd all)",
    "retry": false
  }
}
```

JSON-mode (`--output json`): error envelope is on **stdout** (not stderr). Exit code carries the semantic class. Text mode keeps errors on stderr.

## envelope cheat-sheet

| Command | Top-level shape |
|---|---|
| `list` | `{api_version, sessions[], total_available, limit, offset, has_more, available_sources, cursor, meta, actions}` |
| `read` | `{api_version, session?, meta, messages[], actions}` |
| `info` | `{api_version, id, source, cwd, model, ..., actions}` (flat — no wrapper) |
| `stats` | `{api_version, ...spread of NormalizedSession..., actions}` (flat) |
| `search` | `{api_version, query, sessions_scanned, sessions_available, results[], total_matches, meta, actions}` |
| `doctor` | `{api_version, result:{node_version, sessionr_version, cwd, sources[], warnings[]}}` |
| `send` (sync) | `{api_version, meta, messages[], actions}` |
| `send` (async) | `{api_version, data:{job_id, session_id, source, status, pid, ...}, actions}` |
| `job/wait/cancel` | `{api_version, data:{...job}, actions}` |
| `jobs` | `{api_version, jobs[], total}` |
| `prune --dry-run` | `{api_version, dry_run:true, would_delete[], count}` |
| `tag` | `{api_version, status, tags[]}` |
| `context` | `{api_version, ...context, actions}` (depends on --format) |
| `diff` | `{api_version, ...diff structure}` |
| any error | `{error:{code, message, detail?, suggestion?, retry}}` |

The shape drift (some flat, some wrapped under `data`/`meta`) is documented in `references/error-taxonomy.md` "Known envelope drift" section.
