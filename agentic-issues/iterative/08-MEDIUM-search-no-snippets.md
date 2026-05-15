# 08 · MEDIUM · `search` results give a count, no snippet — agents must `read` each result to know context

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/search.ts`

## Evidence

`search` returns per-session `match_count` only — no snippet, no message index, no character offset. Agents must follow up with `read --search "<query>"` on each interesting session to see what matched.

## Fix

Add `matches[]` per result with `{message_index, snippet (~120 chars centered on the hit), char_offset}`. Cap at 3 per session to keep payload bounded.

```ts
matches: messageHits.slice(0, 3).map(h => ({
  message_index: h.index,
  snippet: ellipsize(h.text, 120, h.matchOffset),
  char_offset: h.matchOffset,
})),
```

## Verification

```bash
sessionr --output json search -q "deploy" | jq '.results[0].matches[0]'
# expect {message_index, snippet, char_offset}
```

## Related

- [[iterative/09-MEDIUM-list-search-50-cap-silent]]
