# 10 · MEDIUM · Parse errors are swallowed by `Promise.allSettled` — agents see "session not found" instead

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/discovery.ts:50-57`, parsers

## Evidence

```ts
// src/discovery.ts:50-57
const results = await Promise.allSettled(adapters.map((a) => a.find()));
for (const result of results) {
  if (result.status === 'fulfilled') merged.push(...result.value);
}
```

Rejections are dropped. If `goose` or `zed` parser crashes (e.g. `node:sqlite` unavailable on Node 18, `zstd` missing for Zed), the user gets fewer sessions silently.

`AGENTS.md` even codifies this: *"Parsers skip bad lines silently — try/catch in `readJsonlFile`, don't crash on malformed data"*. Reasonable for individual lines; **not** reasonable for adapter-level crashes.

## Why this fails an agent

Agent runs `sessionr list`, expects 200 sessions, gets 80 because the Goose adapter threw. No warning. Agent concludes 120 sessions are "missing" or that the user has fewer than they think.

## Fix

Emit a `meta.warnings[]` array surfacing per-adapter rejections:

```ts
const warnings: Array<{source: SessionSource, error: {code: string, message: string}}> = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === 'rejected') {
    warnings.push({
      source: adapters[i].name,
      error: { code: 'ADAPTER_FAILED', message: String(r.reason?.message ?? r.reason) },
    });
  } else merged.push(...r.value);
}
return { entries: deduped, warnings };
```

Plumb `warnings` into the list/search/read envelopes (`meta.warnings`).

For `loadSession`, propagate `ParseError` rather than letting it become `SessionNotFoundError`.

## Verification

```bash
sessionr list --output json | jq '.meta.warnings // []'
# expect: empty if everything works; otherwise an item per failing adapter
```

## Related

- [[errors/09-MEDIUM-no-retry-semantics]]
- [[discovery/07-MEDIUM-no-doctor-command]]
