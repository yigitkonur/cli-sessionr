# 03 · CRITICAL · `spawnAndWait` allocates stdout/stderr pipes but never reads them — tool output is silently discarded

**Context:** write-path · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/send.ts:293-318`

## Evidence

```ts
// src/commands/send.ts:298-301
const child = spawn(cmd.bin, cmd.args, {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Pipes created. No `child.stdout.on('data', …)`, no `child.stderr.on('data', …)`, no `child.stdout.pipe(...)`. On macOS/Linux the pipes will fill the OS buffer (~64KB) and the child process will **block on stdout** until the parent drains. For long-running tools (claude, codex) writing more than 64KB, this either deadlocks the child or causes inconsistent output truncation.

Even when buffers don't fill, the captured output is thrown away. After the child exits, `runSync` (`send.ts:119`) re-loads the session from disk to compute the new messages — losing all of the live tool output that could have been streamed back to the agent.

## Why this fails an agent

Two bugs in one:

1. **Deadlock risk** for any tool that writes >64KB to stdout/stderr while sessionr is the parent.
2. **Lost telemetry**: errors, warnings, JSON lines, and progress from the upstream tool are dropped. If the tool fails partway, the agent has no diagnostic — only "tool exited with code N".

## Fix

Stream both stdout and stderr to the parent's stderr (so the agent that reads `--output json` from stdout still gets a clean parse), and capture them so the JSON envelope can include the tail of stderr on a non-zero exit:

```ts
const tailLines: string[] = [];
function tap(stream: NodeJS.ReadableStream) {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);            // live mirror to agent
    buf += chunk.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      tailLines.push(line);
      if (tailLines.length > 50) tailLines.shift();
    }
  });
}
tap(child.stdout);
tap(child.stderr);
…
// on non-zero exit:
throw new SessionReaderError(`Tool ${cmd.bin} exited with code ${exitCode}`, {
  code: 'TOOL_ERROR',
  exitCode: EXIT.ERROR,
  detail: { tool: cmd.bin, exit_code: exitCode, source: resolvedSource, stderr_tail: tailLines.join('\n') },
});
```

## Verification

```bash
# Send a prompt that intentionally produces big stdout from the tool, watch stderr live:
sessionr send <id> -m "print 100000 numbers"     # stderr mirrors live output, no deadlock
sessionr send <id> -m "trigger an error" --output json 2>err.log; jq .error.detail.stderr_tail err.log
```

## Related

- [[write-path/04-HIGH-job-status-only-stderr-heuristic]]
- [[write-path/06-HIGH-send-detect-session-fail-exit-zero]]
