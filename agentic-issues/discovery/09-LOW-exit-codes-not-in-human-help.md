# 09 · LOW · Exit codes documented in JSON help only — invisible in `--help`

**Context:** discovery · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts:421`

## Evidence

`buildHelpSchema` (`src/cli.ts:421`) emits `exit_codes` in JSON help, but human `--help` never mentions any of them.

## Fix

Append to top-level `--help` via `program.addHelpText('after', …)`:

```
Exit codes
  0   Success
  1   Internal error
  2   Bad usage / validation
  3   Session/job/resource not found
  4   Authentication required (reserved)
  5   Rate-limited / transient (reserved)
  10  Partial result (truncated by token budget)
  42  No changes (--if-changed match)
```

## Verification

```bash
sessionr --help | grep -c '^  [0-9]'   # expect ≥6
```

## Related

- [[errors/04-MEDIUM-exit-codes-mostly-unused]]
