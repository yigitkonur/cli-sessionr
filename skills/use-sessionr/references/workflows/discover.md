# Discovery workflow — list / search / doctor

How to find a session when the user gives you a description, a phrase, a project, or nothing at all.

## The mental model

Discovery has three tiers, in order of cost:

1. **`sessionr list`** — cheapest. Reads only the per-source `find()` output (no message parsing). Returns the most recent N sessions ranked by `updatedAt`, scoped by `--cwd`.
2. **`sessionr list -q "<phrase>"`** — list + content scan capped at `--max-sessions` (default 50). Uses `loadSession()` per entry.
3. **`sessionr search -q "<phrase>"`** — full search with snippets + offsets. Capped at `--max-sessions` (default 20, max 200 reasonable).

Pick the cheapest tier that gives you a unique answer.

## Cwd scoping

Default is `--cwd auto`:
1. Apply `entry.cwd === process.cwd()` filter.
2. If non-empty: return that filtered list, set `meta.cwd_scope = "auto"`.
3. If empty: return the global list, set `meta.cwd_scope = "fellback_to_global"`.

Other modes:

| Mode | Behavior | When to use |
|---|---|---|
| `--cwd auto` (default) | $PWD-first with global fallback | Most agent flows. Surfaces project work first; doesn't lie when nothing matches. |
| `--cwd current` | Strict $PWD only; empty if no match | When the user says "sessions for this project" and you must NOT show global. |
| `--cwd all` | No cwd filter | When the user explicitly wants global. |
| `--cwd /abs/path` | Strict to that path | When user names a project that isn't `$PWD`. |

Always surface `meta.cwd_scope` and `meta.cwd` to the user when scope mode matters. "Showing 12 sessions in `~/dev/lets-talk`" is more useful than "Showing 12 sessions".

## Patterns

### "What sessions are in this repo"

```bash
sessionr list --cwd current --output json
```

Empty? Either the user hasn't worked here with any of the 11 tools, OR the source's data dir mis-detects this cwd. Run `sessionr doctor` next.

### "Show me recent Claude work"

```bash
sessionr list claude --cwd auto --output json -n 10
```

### "Find sessions where I asked about <X>"

Quick (≤50 sessions):

```bash
sessionr list -q "<X>" --output json
```

Deep with snippets (≤200 sessions):

```bash
sessionr search -q "<X>" --max-sessions 200 --output json
```

The two are different commands with different envelope shapes. `list -q` returns full `SessionListEntry` rows (id/source/cwd/summary). `search -q` returns ranked `SearchResult` rows with snippets and char offsets.

### "Find that session — I pasted a UUID"

User pasted `2d9100c7` or `2d9100c7-7ff7-46e1-91e3-7631263970b0`. Skip discovery — go straight to `read`:

```bash
sessionr read 2d9100c7 --output json
```

Sessionr accepts any unique prefix. If the prefix matches multiple sessions, you get `SESSION_NOT_FOUND` with `error.detail.prefix_matches[]` — disambiguate by source or cwd.

### "Compare what was being done across projects"

```bash
sessionr list --cwd all -n 50 --output json | jq '.sessions | group_by(.cwd) | map({cwd: .[0].cwd, count: length, latest: max_by(.updatedAt).updatedAt})'
```

### "What's been happening in the last 24h"

```bash
SINCE=$(date -u -d "24 hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)
sessionr list --cwd all -n 200 --output json | jq --arg since "$SINCE" '.sessions | map(select(.updatedAt > $since))'
```

(Sessionr doesn't have a built-in `--since` filter; do it client-side.)

## When `list` returns empty

The cleanest diagnostic is `sessionr doctor`:

```bash
sessionr doctor --output json | jq '.result.sources[] | {name, data_dir, data_dir_exists, session_count, spawn_bin_resolvable}'
```

For each source:

- `data_dir_exists: false` → that tool was never used here. Skip it.
- `data_dir_exists: true, session_count: 0` → tool installed but no sessions. Surface that.
- `data_dir_exists: true, session_count: >0` BUT empty in `list` → cwd filter is hiding everything; rerun with `--cwd all`.

Also check `meta.warnings[]` on the original `list` envelope — adapter-level errors land there. A `zed: zstd missing` warning means the source was skipped, not that there are no zed sessions.

## The 50-session search cap

`list -q` scans only the 50 most recent sessions (configurable via `--max-sessions`, capped at 200). If the user asks "find that session from 2 weeks ago about X" and recency >50, you'll miss it. Either:

1. Use `sessionr search -q "X" --max-sessions 200 --output json` (the dedicated search command).
2. Page through `list` first, then search within a date window.

The envelope hoists this cap to `meta.search`:

```jsonc
"meta": {
  "search": {
    "query": "X",
    "sessions_scanned": 50,
    "sessions_available": 412,
    "truncated": true
  }
}
```

When `truncated: true`, surface "I scanned only the 50 most recent sessions; there are 412 in total" to the user before they conclude their session doesn't exist.

## Source filter precedence

`sessionr list claude` (positional) and `sessionr list --source claude` (no such flag on `list`) — the positional is the only way for `list`. `read`/`info`/`stats`/`send` use `--source` (or `-s`). Aliases (`cc`/`cli`/`cx`/`gm`) work on both.

## Output mode tradeoffs

- `--output json` — single object with all sessions inline. Fine for ≤200 sessions.
- `--output jsonl` — one `{type:'meta', ...}` line then one `{type:'session', ...}` per session. Use for streaming or piping into per-line tools.
- `--output text` — human-readable; only when you're rendering to the user. Never grep.
