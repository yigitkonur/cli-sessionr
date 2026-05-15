# 14 · MEDIUM · `actions` and `next_action` are emitted **after** the messages array — bad for streaming agents

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:285-307`

## Evidence

```ts
// src/commands/read.ts:285-307
const envelope: Record<string, unknown> = { api_version: 1 };
if (summary) envelope.session = summary;
envelope.meta = meta;
envelope.messages = messages.map((m) => ({...}));    // ← potentially huge
envelope.actions = [...];                            // ← appended LAST
```

For a 10K-message session at preset `full`, the agent must consume the entire `messages` array before reaching `actions`. With JSONL streaming this would be a non-issue — but JSONL is broken for `read` too (see [[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]] for sibling bug).

## Why this fails an agent

Agents using `jq -c` style streaming can only emit `actions` once they've buffered the full body. For interactive UIs that show the next action *before* the messages render, the cost is high latency.

## Fix

Reorder envelope keys so steering metadata leads:

```ts
const envelope = {
  ok: true,
  schema_version: 'v1',
  meta: {…},
  next_action: {…},
  actions: [...],
  result: { session: summary, messages: [...] },   // last
};
```

For JSONL `read`, emit:
1. one `{type:'meta', …}` line
2. one `{type:'next_action', …}` line
3. one `{type:'message', …}` per message
4. one `{type:'done', etag, total_messages_returned}` to terminate

This lets agents act on metadata immediately and stream messages as they arrive.

## Verification

```bash
sessionr --output json read <id> | jq 'keys'
# expect actions/next_action/meta to appear before result.messages
```

## Related

- [[iterative/01-HIGH-etag-not-in-read-response]]
