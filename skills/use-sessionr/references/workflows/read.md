# Read workflow — token budget, anchors, ETag, pagination

How to extract messages from a session without OOMing, missing context, or polling wastefully.

## Anatomy of a read

```
sessionr read <id> [from] [to] \
  --tokens 8000 \           # budget; default 8000, max ~8000
  --anchor head \           # where the slice is centered: head | tail | search
  --search "query" \        # required when --anchor search
  --preset verbose \        # truncation profile per block type
  --role user,assistant \   # filter by role (any subset)
  --page 1 \                # 1-based page; alternate to before/after
  --before 50 \             # cursor: messages before index 50
  --after 22 \              # cursor: messages from index 23 onward
  --if-changed <etag> \     # 304-style polling
  --include-summary \       # repeat session summary on every page (default: page 1 only)
  --batch ids.txt \         # newline-separated IDs → JSONL stream
  --output json
```

`from` and `to` are 1-based message indices when both `--page` and `--before/--after` are absent.

## Token budget mechanics

Default budget: 8000 tokens (`SESSIONREADER_MAX_TOKENS` env can override; capped at ~8K).

When the slice exceeds the budget:
- Sessionr trims toward the anchor (head: keep earliest messages; tail: keep latest; search: keep messages around the match).
- Returns exit code 10 (`PARTIAL`).
- Sets `meta.partial = true`, `meta.has_more_before/after`, and `meta.cursor.next` with a copy-paste command for the next page.

```jsonc
"meta": {
  "token_budget": 8000,
  "returned_tokens_estimate": 7920,
  "total_tokens_estimate": 24500,
  "has_more_after": true,
  "cursor": {
    "next": "sessionr read <id> --after 22 --tokens 8000",
    "prev": null,
    "first": null
  },
  "partial": true
}
```

The agent's loop: read with budget → check `meta.partial` → if true, run `meta.cursor.next` → repeat.

## Anchors

| `--anchor` | Meaning | When to use |
|---|---|---|
| `head` (default) | Slice from message #1 forward | "What was the original prompt", general traversal |
| `tail` | Slice ending at the last message | "What did the model finally say", final summary, error at the end |
| `search` | Slice centered on the first match for `--search "<query>"` | "What did the model say about X", looking for a specific point |

`--anchor search` requires `--search`. Without it: `INVALID_ANCHOR_USAGE` exit 2.

## Anchor messages (never truncated, v2.8.1+)

Independent of any preset:

- The **leading system/user run** at the start of the session — the init prompt plus any system framing — is rendered in full.
- The **last assistant message** in the session is rendered in full.

This is implemented in the formatters (`tty.ts`/`plain.ts`) for human output. JSON output already returns full content per message; the rule matters only for human-rendered text.

## Presets

| Preset | maxContentChars | maxToolInputChars | maxToolResultChars | showThinking | maxThinkingChars | showToolArgs | showToolResults | rough tokens per message |
|---|---|---|---|---|---|---|---|---|
| `minimal` | 80 | 0 | 0 | false | 0 | false | false | ~5 |
| `standard` | 500 | 60 | 80 | false | 0 | true | true | ~30 |
| `verbose` (default for agents) | 2000 | 200 | 500 | true | 200 | true | true | ~150 |
| `full` | ∞ | ∞ | ∞ | true | ∞ | true | true | ~600+ |

Pick by: how many messages do you need to fit, and how much detail per message?

- 32-message session, want everything: `--preset full --tokens 8000`
- 1000-message session, want headlines: `--preset minimal --tokens 8000`
- 100-message session, want tool calls but not full results: `--preset standard --tokens 8000`

`--detail full|condensed|skeleton|meta` is an alternative axis: `meta` strips message content entirely, `skeleton` keeps a 60-char teaser per message. Use `--detail` for fast structural overviews; `--preset` for token-tuned detail.

## ETag-based polling

Capture the etag on the first read:

```bash
ETAG=$(sessionr read <id> --output json | jq -r .meta.etag)
```

Subsequent polls:

```bash
sessionr read <id> --if-changed "$ETAG" --output json
echo $?   # 42 = unchanged; 0 = changed (new etag in response)
```

The etag hashes session content + `--preset` + `--tokens` + slice (`from/to/page/anchor/search`). Two reads with the same etag means literally the same body; you can skip re-rendering.

When unchanged (exit 42), the body is `{unchanged: true, etag, meta:{...}}` so you still get the etag back for the next poll.

When changed, the response includes a fresh `meta.etag` — capture and re-poll with that.

Do **not** bare-loop `read` for change detection — it'll re-parse the entire session every call.

## Pagination patterns

### Linear forward through entire session

```bash
NEXT="sessionr read <id> --tokens 4000 --output json"
while true; do
  RESP=$(eval "$NEXT")
  echo "$RESP" | jq '.messages[]'
  HAS_MORE=$(echo "$RESP" | jq -r '.meta.has_more_after')
  [ "$HAS_MORE" = "true" ] || break
  NEXT=$(echo "$RESP" | jq -r '.meta.cursor.next')
done
```

### Read by page

```bash
sessionr read <id> --page 1 --tokens 4000 --output json
sessionr read <id> --page 2 --tokens 4000 --output json
# pages_estimate is in meta.page.total
```

### Read window around a phrase

```bash
sessionr read <id> --anchor search --search "<phrase>" --tokens 4000 --output json
```

### Read final N messages

```bash
sessionr read <id> --anchor tail --tokens 4000 --output json
```

### Read by message index

```bash
sessionr read <id> 1 50 --output json          # messages #1 through #50
sessionr read <id> --before 50 --output json   # everything before message #50
sessionr read <id> --after 22 --output json    # everything from message #23 forward
```

## Role filtering

```bash
sessionr read <id> --role user,assistant --output json     # human conversation only
sessionr read <id> --role tool_use --output json           # tools the agent invoked
sessionr read <id> --role tool_use,tool_result --output json  # full tool transcript
```

Roles: `user`, `assistant`, `system`, `tool_use`, `tool_result`. Unknown role → `INVALID_ROLE` exit 2 with `detail.unknown` and `detail.valid`.

## Batch read

For "read these N sessions and summarize each":

```bash
echo "<id1>" > /tmp/ids.txt
echo "<id2>" >> /tmp/ids.txt
echo "<id3>" >> /tmp/ids.txt
sessionr read --batch /tmp/ids.txt --tokens 1000 --output jsonl
```

Output is JSONL with `{type: "meta", count: N}` then per-session `{type: "session", ...}` then per-message `{type: "message", session_id, ...}`. Stream-friendly; do not use `--output json` for batch (would buffer the whole result).

## Detail hints

When the current preset truncated something, the response carries:

```jsonc
"meta": {
  "detail_hint": {
    "current_preset": "standard",
    "hidden_tool_calls": 0,
    "truncated_results": 12,
    "thinking_hidden": false,
    "upgrade_options": [
      { "preset": "verbose", "estimated_tokens": 1500, "command": "sessionr read <id> --preset verbose --tokens 4000" },
      { "preset": "full",    "estimated_tokens": 4200, "command": "sessionr read <id> --preset full --tokens 8000" }
    ]
  }
}
```

Surface this to the user when relevant. The `command` field is copy-paste-ready.

## Common mistakes

- Forgetting `--output json` and trying to grep the human format.
- Bare-looping `read` instead of `read --if-changed`.
- Reading a 100k-message session without `--tokens` (OOM risk; the tool caps at ~8K but per-message rendering can still spike).
- Asking for `--anchor search` without `--search` (validation error, exit 2).
- Treating exit 10 (PARTIAL) as failure. It isn't — the body is valid JSON.
- Ignoring `meta.detail_hint.upgrade_options[].command` and re-deriving the next-step manually.
