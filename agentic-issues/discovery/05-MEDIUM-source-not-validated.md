# 05 · MEDIUM · Invalid `--source` (typo) returns empty list with exit 0 — no validation

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts:44`, `src/commands/list.ts:23`, `src/parsers/registry.ts`

## Evidence

Probes `_probes/09_list_bad_source.txt` and `_probes/10_list_bad_source_json.txt`: `sessionr list nonexistent` → empty `sessions[]`, exit 0. No error, no warning.

`getAdapters(source)` returns `[]` if `source` matches no registered adapter. `Promise.allSettled([])` yields `[]`, `merged` is empty. Caller can't distinguish "valid source, no sessions" from "typo'd source".

## Why this fails an agent

Agent passes `--source claud` (missing `e`). It assumes the empty result is the truth and reports "no Claude sessions found." User loses trust in the tool.

## Fix

Validate at the CLI boundary:

```ts
const SOURCES_LIST = ['claude','codex','gemini','copilot','cursor-agent','commandcode','goose','opencode','kiro','zed'];
function assertSource(s?: string) {
  if (s && !SOURCES_LIST.includes(s)) {
    throw new SessionReaderError(`Unknown source "${s}".`, {
      code: 'INVALID_SOURCE', exitCode: EXIT.USAGE,
      detail: { provided: s, valid: SOURCES_LIST },
      suggestion: `sessionr list  (valid: ${SOURCES_LIST.join(', ')})`,
    });
  }
}
```

Call from every command that accepts `--source` or `[source]`.

## Verification

```bash
sessionr list claud --output json 2>&1 | jq .error.code    # expect "INVALID_SOURCE"
sessionr read <id> --source nope --output json 2>&1 | jq .error.code    # expect "INVALID_SOURCE"
```

## Related

- [[discovery/06-MEDIUM-list-numeric-bounds-not-validated]]
- [[discovery/14-LOW-no-preset-detail-anchor-validation]]
