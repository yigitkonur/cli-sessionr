# Recipes — common multi-step patterns

Pick the recipe that matches the user's intent. Most are 2–4 commands chained with `jq`.

## R1 — "What did Claude do in this repo recently?"

```bash
sessionr list --cwd current --output json | jq '.sessions[:5] | map({id, updatedAt, summary})'
```

If empty:

```bash
sessionr doctor --output json | jq '.result.sources[] | select(.name == "claude")'
```

## R2 — "Resume the most recent session here with a follow-up"

```bash
ID=$(sessionr list --cwd current -n 1 --output json | jq -r .sessions[0].id)
SOURCE=$(sessionr list --cwd current -n 1 --output json | jq -r .sessions[0].source)
sessionr send "$ID" -m "follow-up text" --output json
# OR for long jobs:
JID=$(sessionr send "$ID" -m "follow-up" --async --output json | jq -r .data.job_id)
sessionr wait "$JID"
sessionr read "$ID" --after "$(sessionr info "$ID" --output json | jq .total_messages)" --output json
```

## R3 — "Find the session where I asked about X, then read that part"

```bash
# Quick (≤50 sessions):
HIT=$(sessionr search -q "X" --output json | jq -r '.results[0]')
ID=$(echo "$HIT" | jq -r .id)
sessionr read "$ID" --anchor search --search "X" --tokens 4000 --output json
```

If `results[0]` is empty, widen with `--max-sessions 200`.

## R4 — "Watch this session for new messages (poll loop)"

```bash
ID=<session-id>
ETAG=$(sessionr read "$ID" --output json | jq -r .meta.etag)
while true; do
  sleep 30
  RESP=$(sessionr read "$ID" --if-changed "$ETAG" --output json)
  RC=$?
  if [ $RC -eq 42 ]; then
    continue   # unchanged
  fi
  ETAG=$(echo "$RESP" | jq -r .meta.etag)
  echo "$RESP" | jq '.messages[]'
done
```

The `--if-changed` short-circuit avoids re-rendering the entire session on every poll.

## R5 — "Hand off this session to a fresh agent / different tool"

```bash
sessionr context <id> --tokens 8000 --include-system-prompt --output json > handoff.json
# pass handoff.json into the next agent's prompt:
sessionr send --new -s codex -f <(jq -r .context handoff.json) --output json
```

(Adjust the `jq` extraction to whatever `context`'s output shape ships in the running version.)

## R6 — "Compare what was done across two sessions"

```bash
sessionr diff <id1> <id2> --output json | jq '.diff'
# OR manually:
sessionr read <id1> --output json > /tmp/a.json
sessionr read <id2> --output json > /tmp/b.json
diff <(jq '.messages[] | {role, content}' /tmp/a.json) <(jq '.messages[] | {role, content}' /tmp/b.json)
```

## R7 — "Summarize what each AI tool has done in this repo"

```bash
sessionr list --cwd current -n 200 --output json | \
  jq '.sessions | group_by(.source) | map({source: .[0].source, count: length, latest: max_by(.updatedAt).updatedAt})'
```

Then for the top-N most-active source:

```bash
sessionr list claude --cwd current -n 5 --output json | jq '.sessions[] | {id, summary, updatedAt}'
```

## R8 — "Find sessions that touched file X"

`sessionr stats <id>` returns `filesModified[]` for each session. To search across many:

```bash
sessionr list --cwd current -n 50 --output json | \
  jq -r .sessions[].id | \
  while read ID; do
    sessionr stats "$ID" --output json 2>/dev/null | \
      jq -r --arg file "src/api/handler.ts" 'select(.stats.filesModified[]? == $file) | .id'
  done
```

## R9 — "Read with progressive detail"

```bash
ID=<session-id>
# First pass: cheap overview
sessionr read "$ID" -p minimal --output json | jq '.messages[] | {index, role, content}'
# Then upgrade based on what looked interesting
sessionr read "$ID" -p verbose --tokens 4000 --output json
# If detail_hint suggests the upgrade:
NEXT=$(sessionr read "$ID" -p standard --output json | jq -r '.meta.detail_hint.upgrade_options[0].command')
eval "$NEXT"
```

## R10 — "Background a long send and check back later"

```bash
JID=$(sessionr send <id> -f long-prompt.md --async --output json | jq -r .data.job_id)
echo "Job $JID started; check with: sessionr job $JID"
# … later …
sessionr job "$JID" --output json | jq '.data.status'
# When status is "completed":
sessionr job "$JID" --output json | jq -r '.actions[] | select(.description == "Read new messages") | .command' | sh
```

## R11 — "Bulk-summarize 10 sessions"

```bash
sessionr list -n 10 --output json | jq -r .sessions[].id > /tmp/ids.txt
sessionr read --batch /tmp/ids.txt --tokens 1000 --output jsonl | \
  jq -c 'select(.type == "session") | {id, source, total_messages: .total_messages}'
```

`--batch` is much cheaper than 10 individual `read` invocations.

## R12 — "What's been worked on in the last 24h, across all projects"

```bash
SINCE=$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "24 hours ago" +%Y-%m-%dT%H:%M:%SZ)
sessionr list --cwd all -n 200 --output json | \
  jq --arg since "$SINCE" '.sessions | map(select(.updatedAt > $since)) | group_by(.cwd) | map({cwd: .[0].cwd, count: length})'
```

## R13 — "I have only the first 8 chars of an id and the prefix is ambiguous"

```bash
sessionr read 2d9100c7 --output json 2>&1 | jq '.error.detail.prefix_matches // empty'
# If non-empty, pick the right entry:
sessionr read 2d9100c7 --source claude --output json
# OR pass a longer prefix:
sessionr read 2d9100c7-7ff7 --output json
```

## R14 — "Preview prune before any deletion"

```bash
sessionr prune --older-than 30d --dry-run --output json | jq '{count, sources: .would_delete | group_by(.source) | map({source: .[0].source, count: length})}'
# DO NOT add --yes — it currently returns NOT_IMPLEMENTED and refuses anyway.
# To actually delete, do it manually with the file paths from .would_delete[].file_path.
```

## R15 — "List that respects scope and tells the user which scope is active"

```bash
RESP=$(sessionr list --cwd auto --output json)
SCOPE=$(echo "$RESP" | jq -r .meta.cwd_scope)
CWD=$(echo "$RESP" | jq -r .meta.cwd)
COUNT=$(echo "$RESP" | jq '.sessions | length')

case "$SCOPE" in
  auto)        echo "Showing $COUNT sessions in $CWD" ;;
  fellback_to_global) echo "No sessions in $CWD; showing $COUNT global sessions" ;;
  current)     echo "Showing $COUNT sessions in $CWD (strict scope)" ;;
  all)         echo "Showing $COUNT sessions across all projects" ;;
  explicit)    echo "Showing $COUNT sessions in $CWD (explicit scope)" ;;
esac
```
