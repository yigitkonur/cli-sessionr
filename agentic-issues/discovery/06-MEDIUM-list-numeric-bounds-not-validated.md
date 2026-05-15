# 06 · MEDIUM · `--limit 0`, `--limit -5`, `--offset <huge>` exit 0 with empty results

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/list.ts:21-22`

## Evidence

Probes:
- `_probes/54_list_n0.txt` — `sessionr list -n 0 --output json` → `"limit": 0`, `"sessions": []`, `has_more: true`, exit 0.
- `_probes/55_list_neg.txt` — `sessionr list -n -5` → exit 0 (silently produces something).

`src/commands/list.ts:21-22`:
```ts
const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
const offset = opts?.offset ? parseInt(opts.offset, 10) : 0;
```

No bounds checks; `parseInt("foo")` → NaN → `slice(0, NaN)` returns `[]`.

## Why this fails an agent

Empty result with exit 0 is indistinguishable from "no sessions exist". Agents implement retries/refines on the wrong assumption.

## Fix

```ts
function parseBounded(name: string, raw: string|undefined, def: number, min: number, max?: number) {
  if (raw == null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new SessionReaderError(`${name}: not a number`, {code:'INVALID_ARG', exitCode: EXIT.USAGE});
  if (n < min) throw new SessionReaderError(`${name}: must be >= ${min}`, {code:'INVALID_ARG', exitCode: EXIT.USAGE});
  if (max != null && n > max) throw new SessionReaderError(`${name}: must be <= ${max}`, {code:'INVALID_ARG', exitCode: EXIT.USAGE});
  return n;
}
const limit = parseBounded('--limit', opts.limit, 20, 1, 1000);
const offset = parseBounded('--offset', opts.offset, 0, 0);
```

Apply the same pattern to `--tokens`, `--page`, `--before`, `--after`, `--top`, `--max-sessions`, `--timeout`, `--interval`.

## Verification

```bash
sessionr list -n 0  --output json 2>&1 | jq .error.code   # expect "INVALID_ARG"
sessionr list -n -5 --output json 2>&1 | jq .error.code
sessionr list --offset -1 --output json 2>&1 | jq .error.code
```

## Related

- [[errors/06-MEDIUM-tokens-zero-silent]]
- [[discovery/14-LOW-no-preset-detail-anchor-validation]]
