# 12 · MEDIUM · `jsonl read` emits `blocks` always — `json read` strips them when redundant

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/output/json.ts:48-62`, `src/output/jsonl.ts:46-58`, `src/commands/send.ts:199-205`

## Evidence

`json` formatter (`src/output/json.ts:57-60`) skips `blocks` when redundant:
```ts
if (m.blocks.length > 0 && m.content !== '' &&
    !(m.blocks.length === 1 && m.blocks[0].type === 'text')) {
  msg.blocks = m.blocks;
}
```

`jsonl` formatter (`src/output/jsonl.ts:46-58`) always emits them:
```ts
lines.push(line({ type:'message', index, role, timestamp, tokens_estimate, content, blocks: m.blocks }));
```

`send` envelope (`src/commands/send.ts:199-205`) also always emits `blocks`.

## Why this fails an agent

For a session that's mostly text, the `jsonl` payload is 30–60% larger than the equivalent `json` payload because every text message carries both `content: "…"` and `blocks: [{type:"text", text:"…"}]`. The token cost scales linearly with message count. Agents that switch formats based on streaming needs see a sudden bandwidth/budget regression.

The drift between `read` and `send` shapes also makes it impossible for an agent to write one parser for messages.

## Fix

Apply the json-side dedup to jsonl and to send. Extract a shared:

```ts
// src/output/serialize.ts
export function serializeMessage(m: NormalizedMessage) {
  const o: Record<string, unknown> = {
    index: m.index, role: m.role, timestamp: m.timestamp,
    tokens_estimate: estimateMessageTokens(m), content: m.content,
  };
  if (m.blocks.length > 0 && m.content !== '' &&
      !(m.blocks.length === 1 && m.blocks[0].type === 'text')) {
    o.blocks = m.blocks;
  }
  return o;
}
```

Use it in `json.ts`, `jsonl.ts`, and `send.ts`.

## Verification

```bash
JSON_BYTES=$(sessionr --output json read <id> --tokens 8000 | wc -c)
JSONL_BYTES=$(sessionr --output jsonl read <id> --tokens 8000 | wc -c)
echo "$JSON_BYTES vs $JSONL_BYTES"   # should be within 5%
```

## Related

- [[output-contracts/13-MEDIUM-send-always-emits-blocks]]
- [[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]]
