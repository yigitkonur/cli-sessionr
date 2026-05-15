# 17 · MEDIUM · `context`, `tag`, and `prune` ignore `--output` — always emit JSON

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/context.ts`, `src/commands/tag.ts`, `src/commands/prune.ts`

## Evidence

- `src/cli.ts:281-307` (`context`): action handler does not read `parentOpts.output`.
- `src/cli.ts:187-201` (`tag`): same.
- `src/cli.ts:202-218` (`prune`): forwards `output` but `prune.ts` ignores it (always JSON).

## Why this fails an agent

Inconsistent: agents that pipe everything through `jq` set `--output json` once at the top level and assume every subcommand respects it. These three commands silently break the assumption: today they're already JSON, but if `--output text` is the agent's default for human-readable steps, the agent gets a JSON dump instead of the requested format. More importantly, **JSONL streaming is impossible** for `context` even though it produces a long messages list.

## Fix

Wire `output` through and route the rendered output through the formatter:

```ts
program.command('context', { hidden: true })
  …
  .action(async (sessionId, opts) => {
    const parentOpts = program.opts();
    await contextExportCommand(sessionId, {
      …,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

// inside contextExportCommand: createFormatter({output, isTTY}); emit accordingly.
```

Same for `tag` and `prune`.

## Verification

```bash
sessionr --output jsonl context <id> | head -1 | jq .type   # expect "meta"
sessionr --output text tag <id> --add foo                   # expect human-readable confirmation, not JSON
```

## Related

- [[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]]
