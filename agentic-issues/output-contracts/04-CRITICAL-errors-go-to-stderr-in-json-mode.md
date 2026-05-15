# 04 · CRITICAL · Error envelopes go to **stderr** even when caller asked for `--output json`

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** every command's catch block; root cause is the convention encoded in `formatter.error()`

## Evidence

Catch blocks across the codebase:

- `src/commands/list.ts:87` — `console.error(formatter.error(error))`
- `src/commands/read.ts:273` — `console.error(formatter.error(error))`
- `src/commands/info.ts:59` — `console.error(formatter.error(error))`
- `src/commands/stats.ts:44` — `console.error(formatter.error(error))`
- `src/commands/search.ts:91` — `console.error(formatter.error(error))`
- `src/commands/diff.ts:60-62` — `console.error(JSON.stringify(...))` (also bypasses formatter)
- `src/commands/context.ts`, `src/commands/tag.ts`, `src/commands/job.ts`, `src/commands/send.ts` — same pattern.

Probes prove it:

- `_probes/13_read_bad_id.txt` (stdout): empty.
- `_probes/13_read_bad_id.err` (stderr): the JSON error envelope.
- `_probes/14_read_bad_id_json.txt` (stdout): empty.
- `_probes/14_read_bad_id_json.err` (stderr): the JSON envelope.

## Why this fails an agent

The `optimize-agentic-cli` skill's first core check is *"stdout is pure machine output"*. The corollary for errors is: **in `--output json` mode, the JSON envelope (success **or** error) belongs on stdout** so a single `cmd | jq` pipeline parses both. Splitting success-to-stdout and error-to-stderr forces the agent to:

1. capture stdout and stderr separately, OR
2. merge with `2>&1` and lose stream fidelity, OR
3. branch on exit code to decide which stream to read.

All three add complexity and bugs. The most common failure: agent sets `result = json.loads(stdout)` and crashes with empty-string-not-JSON because the actual envelope went to stderr.

The TTY path can keep `console.error` (humans read both). JSON callers should not.

## Fix

Centralize. Add a helper:

```ts
// src/output/emit.ts
export function emit(channel: 'data'|'error', payload: unknown, isJson: boolean) {
  const s = JSON.stringify(payload, dateReplacer, 2);
  if (isJson) process.stdout.write(s + '\n');     // JSON mode: everything on stdout
  else process[channel === 'error' ? 'stderr' : 'stdout'].write(s + '\n');
}
```

Call sites:

```ts
} catch (err) {
  const isJson = outputFormat === 'json' || outputFormat === 'jsonl';
  if (isJson) {
    process.stdout.write(formatter.error(err) + '\n');
  } else {
    process.stderr.write(formatter.error(err) + '\n');
  }
  process.exitCode = exitCodeForError(err);
}
```

For TTY/text mode, keep stderr. For JSON/JSONL, always emit on stdout.

## Verification

```bash
sessionr read deadbeef --output json 1>got.out 2>got.err
test -s got.out && echo OK_stdout_has_envelope
test ! -s got.err && echo OK_stderr_empty
jq .error.code <got.out
```

## Related

- [[output-contracts/05-CRITICAL-send-validation-bypasses-formatter]]
- [[output-contracts/09-HIGH-error-envelope-shape-inconsistency]]
- [[errors/02-HIGH-send-plain-text-stderr-errors]]
