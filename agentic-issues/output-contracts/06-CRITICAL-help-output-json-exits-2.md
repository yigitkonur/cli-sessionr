# 06 · CRITICAL · `--output json help` exits **2** instead of 0 — agents see help as a failure

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** `src/cli.ts:430-453`

## Evidence

Probes:
- `_probes/02_help_json.txt` — JSON help body printed to stdout… and `exit=2`.
- `_probes/39_help_send_json.txt` — exit=2.
- `_probes/40_help_list_json.txt` — exit=2.

Looking at the cli.ts catch block:

```ts
// src/cli.ts:430-453
try { await program.parseAsync(); }
catch (err) {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exitCode = 0;
    } else {
      …
      process.exitCode = 2;
    }
  }
}
```

The branch *looks* correct, but `program.helpInformation` was overridden to JSON-stringify `buildHelpSchema(program)` (lines 366-375). When `help send` runs, Commander throws `CommanderError` with code `'commander.help'` (single-arg form), which is **not** the same as `'commander.helpDisplayed'` (the `outputHelp()` form). The branch falls into the `else` and sets exit 2. The body is printed (via `helpInformation` override on stdout), but the exit code lies.

## Why this fails an agent

Agents discover the CLI shape via `--output json help`. They:

1. Parse the JSON body → success.
2. Check `$? == 0` → fail.
3. Conclude the JSON is unreliable / treat as error.

Either the agent silently ignores the exit code (and stops trusting it for real errors) or it errors out and never moves past discovery. Both outcomes are bad.

## Fix

Broaden the success-classifier in cli.ts:

```ts
const SUCCESSFUL_HELP = new Set([
  'commander.help',           // help <cmd>
  'commander.helpDisplayed',  // --help
  'commander.version',        // -V
]);
if (SUCCESSFUL_HELP.has(err.code)) {
  process.exitCode = 0;
  return;
}
```

Also add a regression test that asserts every `sessionr ... --help`, `sessionr help <sub>`, and `sessionr --output json help` exits 0.

## Verification

```bash
sessionr --output json help; echo $?              # expect 0
sessionr --output json help send; echo $?         # expect 0
sessionr --output json help list; echo $?         # expect 0
sessionr --version; echo $?                       # expect 0
sessionr list --help; echo $?                     # expect 0
```

## Related

- [[discovery/02-HIGH-hidden-commands-referenced-in-actions]] (help schema is the only discovery surface for hidden commands)
