# 03 · CRITICAL · Unknown `--output` values (xml, csv, …) are silently accepted

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** `src/cli.ts:26`, `src/config.ts:109-119`, `src/output/formatter.ts:27-29`

## Evidence

- `src/cli.ts:26` — `--output <format>` is a free-form string, no `.choices()` enforcement.
- `src/config.ts:114` — `if (opts.output) return opts.output;` returns whatever the user typed, no validation against `['json','jsonl','table','text']`.
- `src/output/formatter.ts:27-29` — `default: return createPlainFormatter();` silently maps any unknown format to plain text.

Probe `_probes/71_unknown_format.txt`: `sessionr --output xml list` exits **0** and prints the markdown table.

## Why this fails an agent

Agents typo flags. A typo like `--output cvs` instead of `csv` should fail loudly so the caller can repair before processing the response. Today it succeeds, returns the wrong format, and downstream parsers crash with the usual confusing JSON-in-text errors. Agents don't get a clear `INVALID_OUTPUT_FORMAT` signal.

## Fix

Two-line change. In `src/cli.ts`:

```ts
program
  .option('--output <format>', 'Output format: json, jsonl, table, text')
  .hook('preAction', () => {
    const v = program.opts().output;
    if (v && !['json','jsonl','table','text'].includes(v)) {
      throw new SessionReaderError(`Invalid --output value "${v}". Valid: json, jsonl, table, text.`, {
        code: 'INVALID_OUTPUT_FORMAT', exitCode: EXIT.USAGE,
        suggestion: 'sessionr --output json list',
      });
    }
  });
```

(Also drop `table` from the valid set if you adopt fix #02.)

## Verification

```bash
sessionr --output xml list
echo $?           # expect 2
sessionr --output xml list --output json 2>&1 | jq .error.code  # expect "INVALID_OUTPUT_FORMAT"
```

## Related

- [[output-contracts/02-CRITICAL-output-table-is-a-lie]]
- [[errors/04-MEDIUM-exit-codes-mostly-unused]]
