# 01 · CRITICAL · `--output jsonl` on `list` returns ONE giant JSON object, not JSONL

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/list.ts:45`, `src/output/jsonl.ts:63`

## Evidence

- `src/commands/list.ts:45` — `if (outputFormat === 'json' || outputFormat === 'jsonl')` short-circuits **both** formats through the same `JSON.stringify(result, dateReplacer, 2)` path on line 81. The `formatter.list()` JSONL implementation in `src/output/jsonl.ts:63` (which actually emits one `{type:'session', ...}` per line) is **never reached** for the list command.
- Probes:
  - `_probes/04_list_json.txt` (`--output json`) and `_probes/05_list_jsonl.txt` (`--output jsonl`) are **byte-identical: 9358 bytes each**.
  - `head -5 _probes/05_list_jsonl.txt` shows `{`, `  "api_version": 1,`, `  "sessions": [`, `    {` — that is JSON, not JSONL.

```text
$ wc -c _probes/04_list_json.txt _probes/05_list_jsonl.txt
9358 _probes/04_list_json.txt
9358 _probes/05_list_jsonl.txt
```

The same bug pattern exists in `src/commands/stats.ts`, `src/commands/info.ts`, `src/commands/search.ts`, `src/commands/diff.ts`, `src/commands/prune.ts`, `src/commands/tag.ts`, `src/commands/context.ts` — each hand-rolls JSON emission and never invokes the jsonl formatter.

## Why this fails an agent

JSONL exists so a streaming consumer can parse one record per `\n`-delimited line and apply backpressure. Agents commonly pipe to `jq -c` or to a line-buffered reader. When `--output jsonl` returns a pretty-printed JSON object spanning hundreds of lines, every `jq -c '.[]'` style consumer breaks. The agent either has to detect the lie or buffer the entire response, defeating the purpose of choosing JSONL.

This is also a **silent contract violation**: stdout exits 0, no warning, no `--output jsonl` rejection. The schema lies.

## Fix

In `src/commands/list.ts:45-81` (and equivalents in the other commands above), branch json vs jsonl explicitly and route jsonl through `formatter.list(entries)` (which is already correct in `src/output/jsonl.ts:63`). For pagination metadata, prepend a single `{type:'meta', api_version, total_available, limit, offset, has_more, cursor}` line *before* the per-session lines, then append `{type:'actions', actions:[…]}` at the end. Each line still parses as one JSON value.

```ts
if (outputFormat === 'jsonl') {
  process.stdout.write(JSON.stringify({type: 'meta', api_version: 1, total_available, limit, offset, has_more, cursor}, dateReplacer) + '\n');
  for (const e of entries) process.stdout.write(JSON.stringify({type: 'session', ...e}, dateReplacer) + '\n');
  process.stdout.write(JSON.stringify({type: 'actions', actions}, dateReplacer) + '\n');
  return;
}
```

## Verification

```bash
sessionr list -n 5 --output jsonl | wc -l       # expect ≥6 lines (meta + 5 sessions + actions)
sessionr list -n 5 --output jsonl | head -1 | jq .type  # expect "meta"
diff <(sessionr list -n 5 --output json | wc -c) <(sessionr list -n 5 --output jsonl | wc -c)  # must NOT be 0
```

## Related

- [[output-contracts/02-CRITICAL-output-table-is-a-lie]]
- [[output-contracts/03-CRITICAL-output-xml-silently-accepted]]
- [[output-contracts/12-MEDIUM-jsonl-read-emits-redundant-blocks]]
