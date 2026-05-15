# 13 · MEDIUM · `send` envelope always emits `blocks` for every message

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/send.ts:199-205`

See [[output-contracts/12-MEDIUM-jsonl-read-emits-redundant-blocks]] for the broader pattern. Same fix: route through `serializeMessage()`.

## Evidence

```ts
// src/commands/send.ts:199-205
envelope.messages = outputMessages.map((m) => ({
  index: m.index,
  role: m.role,
  timestamp: m.timestamp,
  content: m.content,
  blocks: m.blocks,    // always included
}));
```

vs `read.ts:288-298` which conditionally omits blocks.

## Fix

Same as [[output-contracts/12-MEDIUM-jsonl-read-emits-redundant-blocks]] — share `serializeMessage()`.

## Verification

```bash
sessionr --output json send <id> -m "ping" --tokens 1000 | jq '.messages[0] | keys'
# expect: ["content","index","role","timestamp","tokens_estimate"]   (no "blocks" if message is text-only)
```
