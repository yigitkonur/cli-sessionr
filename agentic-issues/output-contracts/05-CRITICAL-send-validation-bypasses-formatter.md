# 05 · CRITICAL · `send` argument validation writes raw plain text — bypasses the JSON formatter entirely

**Context:** output-contracts · **Severity:** Critical · **Status:** open
**Owners:** `src/cli.ts:243-262`

## Evidence

`src/cli.ts:243-262`:

```ts
if (opts.file && opts.message) {
  process.stderr.write('Error: --message and --file are mutually exclusive\n');
  process.exitCode = 2;
  return;
}
if (opts.file) {
  try { message = readFileSync(opts.file, 'utf-8').trim(); }
  catch (err) {
    process.stderr.write(`Error: Cannot read file "${opts.file}": ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
} else if (opts.message) {
  message = opts.message;
} else {
  process.stderr.write('Error: Either --message or --file is required\n');
  process.exitCode = 2;
  return;
}
```

Probes:
- `_probes/15_send_no_args.err`: `Error: Either --message or --file is required` (raw text on stderr, exit 2).
- `_probes/16_send_no_args_json.err`: same — `--output json` is **completely ignored** because validation runs before any formatter exists.
- `_probes/64_send_both_msg_file.err`: same pattern.

## Why this fails an agent

An agent that pipes `sessionr --output json send` and parses stdout gets nothing. The error message is on stderr as plain text — no `code`, no `class`, no `suggestion`, no `retry`. The agent has no way to recover automatically. Worse, this is the *first* command an agent runs in many workflows (send a prompt to a session), so the very first parsing failure happens here.

## Fix

Move all three checks below the formatter init and throw `SessionReaderError`:

```ts
const isTTY = process.stdout.isTTY ?? false;
const formatter = createFormatter({ output: opts.output, isTTY });
const isJson = (opts.output ?? (isTTY ? 'text' : 'json')) === 'json' || opts.output === 'jsonl';

try {
  let message: string;
  if (opts.file && opts.message) {
    throw new SessionReaderError('--message and --file are mutually exclusive', {
      code: 'CONFLICTING_FLAGS', exitCode: EXIT.USAGE,
      suggestion: 'sessionr send <id> -m "text"  OR  sessionr send <id> -f prompt.md',
    });
  }
  if (opts.file) {
    try { message = readFileSync(opts.file, 'utf-8').trim(); }
    catch (err) {
      throw new SessionReaderError(`Cannot read file "${opts.file}"`, {
        code: 'FILE_NOT_READABLE', exitCode: EXIT.USAGE,
        detail: { path: opts.file, cause: (err as Error).message },
        suggestion: `Check that ${opts.file} exists and is readable`,
      });
    }
  } else if (opts.message) {
    message = opts.message;
  } else {
    throw new SessionReaderError('Either --message or --file is required', {
      code: 'MISSING_MESSAGE', exitCode: EXIT.USAGE,
      suggestion: 'sessionr send <id> -m "your prompt"',
    });
  }
  // …
} catch (err) {
  emit('error', { error: (err as SessionReaderError).toJSON() }, isJson);
  process.exitCode = exitCodeForError(err);
}
```

(Uses the `emit()` helper from `output-contracts/04`.)

## Verification

```bash
sessionr send --output json 2>/dev/null | jq .error.code         # expect "MISSING_MESSAGE"
sessionr send -m a -f /tmp/x --output json 2>/dev/null | jq .error.code  # expect "CONFLICTING_FLAGS"
sessionr send -f /tmp/none.md --output json 2>/dev/null | jq .error.code # expect "FILE_NOT_READABLE"
```

## Related

- [[output-contracts/04-CRITICAL-errors-go-to-stderr-in-json-mode]]
- [[errors/02-HIGH-send-plain-text-stderr-errors]]
