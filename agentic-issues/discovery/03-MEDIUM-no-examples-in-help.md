# 03 · MEDIUM · `--help` shows flags but **zero examples** for any command

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts` (every `program.command(...)`)

## Evidence

Run `sessionr --help`, `sessionr list --help`, `sessionr read --help`, `sessionr send --help`. None contain an `Examples:` section. The skill expects examples to anchor agents on realistic flag combinations.

## Why this fails an agent

A first-time agent looking at `read --help` sees `--anchor head|tail|search`, `--search`, `--page`, `--before`, `--after`, `--tokens`, `--preset`, `--detail`, `--role`, `--if-changed` — that's 10 ways to slice. With no examples, the agent has to guess which combinations are valid. Guesses lead to retries and wasted tokens.

## Fix

Add `.addHelpText('after', ...)` to each command. Suggested examples:

```ts
program.command('list').addHelpText('after', `
Examples:
  $ sessionr list --cwd current                 # sessions in this directory
  $ sessionr list claude -n 5                   # 5 most recent Claude sessions
  $ sessionr list -q "deploy script"            # search across recent sessions
  $ sessionr list --output json | jq '.sessions[].id'`);

program.command('read').addHelpText('after', `
Examples:
  $ sessionr read 8e46722b                      # head of session, default token budget
  $ sessionr read 8e46722b --anchor tail        # last messages
  $ sessionr read 8e46722b --search "error"     # window around the first match
  $ sessionr read 8e46722b --page 2 --tokens 4000
  $ sessionr read 8e46722b --role tool_use,tool_result
  $ sessionr read 8e46722b --if-changed <etag>  # 304-style polling`);

program.command('send').addHelpText('after', `
Examples:
  $ sessionr send 8e46722b -m "follow up"       # resume sync
  $ sessionr send 8e46722b -f prompt.md         # resume from file
  $ sessionr send --new -s claude -f prompt.md  # new session
  $ sessionr send 8e46722b -m "go" --async      # background, returns job id
  $ sessionr wait <job-id>                      # block until done`);
```

## Verification

```bash
sessionr read --help | grep -A2 'Examples:'   # expect the block above
```

## Related

- [[discovery/02-HIGH-hidden-commands-referenced-in-actions]]
