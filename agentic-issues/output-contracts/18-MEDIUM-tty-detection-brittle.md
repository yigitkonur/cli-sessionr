# 18 · MEDIUM · Output format and preset are auto-chosen from `process.stdout.isTTY` — brittle for agents

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/output/formatter.ts:21-26`, `src/config.ts:97-119`

## Evidence

- `src/config.ts:118` — `return opts.isTTY ? 'text' : 'json';` decides JSON vs text by tty.
- `src/config.ts:97-99` — `return isTTY ? 'standard' : 'verbose';` decides preset by tty.
- `src/output/formatter.ts:21,25` — `if (opts.isTTY && !process.env.NO_COLOR) return createTtyFormatter();` adds chalk colors.

`isTTY` lies in many real environments: tmux pipes, agent supervisors that allocate a PTY, CI that fakes a tty, container layers, `expect`, etc.

## Why this fails an agent

An agent running `sessionr list` from inside Claude Code (no PTY, isTTY=false) gets JSON — fine. The same agent running through a wrapper that allocated a PTY (isTTY=true) gets colored prose, and the JSON parser crashes. The agent's behavior depends on a property of *how the harness invoked node*, not on what was requested.

The skill recommends: never rely on `isTTY` for output choice. Default explicitly.

## Fix

1. Default `--output` to `text` *only* when both `isTTY === true` **and** `--output` was not specified **and** the env var `SESSIONR_AGENT` is not set. Document the env var.
2. For agent harnesses, recommend setting `SESSIONR_AGENT=1` (or `SESSIONR_OUTPUT=json`). Agents who do this get JSON regardless of tty.
3. Stop deriving the preset default from `isTTY`. Expose a single `--preset auto` value that picks based on context once, on first call.

```ts
export function resolveOutputFormat(opts) {
  if (opts.output) return opts.output;
  if (process.env.SESSIONR_OUTPUT) return process.env.SESSIONR_OUTPUT as OutputFormat;
  if (process.env.SESSIONR_AGENT) return 'json';
  if (opts.json) return 'json';
  return opts.isTTY ? 'text' : 'json';
}
```

## Verification

```bash
SESSIONR_AGENT=1 sessionr list | jq .schema_version   # expect parsable JSON regardless of tty
script -q /dev/null -c 'sessionr list' | head -1     # PTY-faked → still JSON if SESSIONR_AGENT=1
```

## Related

- [[output-contracts/07-HIGH-envelope-shape-drift]]
