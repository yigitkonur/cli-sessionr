# 02 · CRITICAL · `--output table` is silently aliased to `text` — no actual tabular format

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** `src/output/formatter.ts:23-26`

## Evidence

```ts
// src/output/formatter.ts:23-26
case 'table':
  if (opts.isTTY && !process.env.NO_COLOR) return createTtyFormatter();
  return createPlainFormatter();
```

`table` falls through to `text`. The plain formatter renders a **markdown** pipe-table for `list` (`src/output/plain.ts:106-114`) — that is closer to a table, but TTY mode is plain colored lines (`src/output/tty.ts:104-125`) with **no columns at all**.

Probe `_probes/06_list_table.txt` and `_probes/07_list_text.txt` are byte-identical when piped (both render the markdown pipe-table). For `read`, `stats`, `info`, and the rest, `--output table` produces unstructured prose, *not* a table.

The CLI advertises `Output format: json, jsonl, table, text` in `src/cli.ts:26` — claiming all four are real options.

## Why this fails an agent

Agents asking for `table` expect either CSV/TSV or fixed-width columns they can `awk` against. Markdown pipe-tables require a parser that handles cell escaping, alignment markers, and the leading `|`. For `read`/`stats`/`info` the agent gets no table at all — just paragraph text — even though the help text promised one.

Worse, on TTY the formatter switches silently between *colored prose* and *markdown table* based on `isTTY`, so an agent that piped `--output table` once and got a parseable markdown table will get colored prose if the same code runs in a PTY.

## Fix

Pick one and do it for real:

1. **Drop the format**: remove `'table'` from `OutputFormat`, reject `--output table` with `INVALID_OUTPUT_FORMAT` (USAGE/exit 2). One-line, zero risk.
2. **Implement it**: emit RFC-4180 CSV (or TSV) for any command that returns a list (`list`, `search`, `jobs`, `prune --dry-run`). Use `--fields a,b,c` to control columns. Reject `--output table` for non-list commands (`read`, `info`) where a row has no obvious shape.

Recommend (1) for v2.5.x. Add (2) in v2.6 if there's demand.

## Verification

```bash
sessionr list --output table -n 3
# expect: structured columnar output, OR a USAGE error if dropped — never markdown pipe-prose
sessionr read <id> --output table 2>&1 | head -5
# expect: USAGE_ERROR with code INVALID_OUTPUT_FOR_COMMAND
```

## Related

- [[output-contracts/03-CRITICAL-output-xml-silently-accepted]]
- [[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]]
