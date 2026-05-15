# 05 · MEDIUM · `cursor.next` / `cursor.prev` are command STRINGS — agents must parse to reuse

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/types.ts:152-156`, `src/commands/list.ts:58-66`

## Evidence

```ts
// list.ts:58-65
const cursor: Record<string, string | null> = {
  next: hasMore ? `sessionr list${source ? ' '+source : ''} --offset ${offset+limit} --limit ${limit}` : null,
  prev: offset > 0 ? `sessionr list${source ? ' '+source : ''} --offset ${Math.max(0, offset-limit)} --limit ${limit}` : null,
};
```

The cursor is a shell command, not a numeric offset. Agents calling sessionr from another language must re-tokenize the string to extract `--offset` / `--limit`.

## Fix

Return both — the structured token *and* the convenience command string:

```ts
cursor: {
  next: hasMore ? { command: `sessionr list ...`, offset: offset+limit, limit } : null,
  prev: offset > 0 ? { command: `sessionr list ...`, offset: Math.max(0, offset-limit), limit } : null,
  first: offset > 0 ? { command: `sessionr list --offset 0 --limit ${limit}`, offset: 0, limit } : null,
}
```

## Verification

```bash
sessionr --output json list -n 5 --offset 5 | jq '.cursor.next | type'   # expect "object"
sessionr --output json list -n 5 --offset 5 | jq '.cursor.next.offset'  # expect 10
```

## Related

- [[iterative/02-HIGH-if-changed-no-output-on-match]]
