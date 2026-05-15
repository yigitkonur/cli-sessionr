# 02 · MEDIUM · `send` (sync and async) has no `--dry-run` — agents loop into runaway sessions

**Context:** destructive · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/send.ts`, `src/runners.ts`

## Evidence

`send` is destructive in the agent sense: it spawns external CLIs (`claude`, `codex`, …) that consume API budget and create files on disk. There is no `--dry-run` flag. There is also no rate-limiting — an agent that loops `send --new` will create dozens of sessions.

## Why this fails an agent

A bug in agent control flow turns into 50 wasted Claude API calls. The agent should be able to run a "what would I run?" probe first.

## Fix

```ts
// src/cli.ts (send command)
.option('--dry-run', 'Print the resolved spawn command and exit 0')

// src/commands/send.ts (top of sendCommand)
if (opts.dryRun) {
  const cmd = isNew
    ? buildNewCommand(source!, opts.message, cwd)
    : buildResumeCommand(source!, resolvedSessionId!, opts.message);
  console.log(JSON.stringify({
    ok: true, schema_version: 'v1',
    result: { dry_run: true, source, cwd, command: cmd, would_spawn: cmd.bin + ' ' + cmd.args.join(' ') },
  }, null, 2));
  return;
}
```

Optionally add `--max-new-per-run <n>` (default 1) to cap accidental fan-out.

## Verification

```bash
sessionr send --new -s claude -m "x" --dry-run --output json | jq '.result.would_spawn'
# expect "claude -p x" — and no child process started
```

## Related

- [[write-path/01-CRITICAL-send-deadbeef-undefined-cmd-crash]]
- [[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]]
