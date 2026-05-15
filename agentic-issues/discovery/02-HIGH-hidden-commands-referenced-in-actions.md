# 02 · HIGH · `actions[]` arrays point at commands hidden from `--help`

**Context:** discovery · **Severity:** High · **Status:** open
**Owners:** `src/cli.ts:124-355`, every emitter that builds `actions`

## Evidence

Hidden commands (defined with `{ hidden: true }`):

- `src/cli.ts:124` `stats`
- `src/cli.ts:139` `info`
- `src/cli.ts:154` `search`
- `src/cli.ts:171` `diff`
- `src/cli.ts:187` `tag`
- `src/cli.ts:202` `prune`
- `src/cli.ts:281` `context`
- `src/cli.ts:313` `jobs`
- `src/cli.ts:325` `job`
- `src/cli.ts:336` `wait`
- `src/cli.ts:351` `cancel`

`actions[]` arrays referencing these hidden commands:

- `src/commands/list.ts:71-72` → `sessionr stats <id>`
- `src/commands/read.ts:303-305` → `sessionr stats`, `sessionr context`, `sessionr diff`
- `src/commands/info.ts:46,48-50` → `sessionr stats`, `sessionr context`, `sessionr tag`, `sessionr prune`
- `src/commands/stats.ts:30-35` → `sessionr context`, `sessionr diff`, `sessionr tag`, `sessionr prune`
- `src/commands/send.ts:269-273` → `sessionr job`, `sessionr wait`, `sessionr cancel`
- `src/commands/job.ts:35-43, 105-109, 184-190` → `sessionr wait`, `sessionr cancel`, `sessionr read`

So `sessionr --help` shows `list`, `read`, `send`, `help`. But `sessionr list --output json` recommends `sessionr stats <id>`. The agent obeys, runs `sessionr stats --help`, and Commander says **"unknown command"** (because hidden commands are excluded from the human help even though they accept their own `--help`). Worse: the JSON help schema `buildHelpSchema` (`src/cli.ts:380-410`) *does* include them, so an agent that knows to call `--output json help` will discover them — but only if it knows.

## Why this fails an agent

The agent is being told to run a command it cannot self-discover through normal `--help`. It either:

1. Trusts the action and runs the hidden command blindly — works, but fragile.
2. Asks for `--help` to learn the flags, finds nothing, gives up or asks the user.

Discoverability and steering are decoupled.

## Fix

1. **Default**: unhide every command that ever appears in any `actions[]` array. Hiding a command that you actively recommend is a bug, not a UX choice.
2. Optional: add an `--include-experimental` flag for commands that are deliberately hidden because they're unstable. Today none of these commands are unstable.
3. Add an `Examples:` block per command (see [[discovery/03-MEDIUM-no-examples-in-help]]).

```ts
// src/cli.ts — drop { hidden: true } on every command listed above
program.command('stats')                     // was: ('stats', { hidden: true })
  .argument('<session-id>', '…')
  …
```

## Verification

```bash
sessionr --help | grep -E '^\s+(stats|info|search|diff|tag|prune|context|jobs|job|wait|cancel)\b'
# expect every name to appear
sessionr stats --help; echo $?    # expect 0 with usage
```

## Related

- [[discovery/03-MEDIUM-no-examples-in-help]]
- [[discovery/08-MEDIUM-list-footer-only-one-tip]]
- [[output-contracts/06-CRITICAL-help-output-json-exits-2]]
