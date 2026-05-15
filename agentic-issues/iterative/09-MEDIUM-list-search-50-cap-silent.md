# 09 · MEDIUM · `list --search` silently caps at 50 most-recent sessions — agents miss matches

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/list.ts:25-41`

## Evidence

```ts
// list.ts:29
for (const entry of allEntries.slice(0, 50)) { … }
```

Hard cap. No warning. If the agent searches for a term that lives in the 75th-most-recent session, it never appears.

## Fix

1. Surface the cap in the response:
   ```ts
   meta.search = {
     query: opts.search,
     sessions_scanned: Math.min(50, allEntries.length),
     sessions_available: allEntries.length,
     truncated: allEntries.length > 50,
   };
   ```
2. Add a `--max-sessions <n>` flag (already exists on `search`; mirror it on `list --search`).
3. Add a `next_action` recommending the dedicated `search` command for deeper coverage.

## Verification

```bash
sessionr --output json list -q "rare term" | jq '.meta.search'
```

## Related

- [[discovery/06-MEDIUM-list-numeric-bounds-not-validated]]
