# 01 · HIGH · `list` (and `search`) have no `--cwd` filter even though every entry already carries `cwd`

**Context:** discovery · **Severity:** High · **Status:** open
**Owners:** `src/cli.ts:44-58`, `src/commands/list.ts`, `src/discovery.ts:45-76`

This is the discovery-layer slice of the same problem covered end-to-end in [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]. Read that first. This file documents the *narrow flag* fix.

## Evidence

`SessionListEntry.cwd` exists (`src/types.ts:81-88`). It is populated by every parser. It is **never** filtered on in `listSessions()` or `listCommand()`.

## Fix (narrow)

Add a flag without changing the default:

```ts
program.command('list')
  …
  .option('--cwd <mode>', 'Filter by cwd: auto | current | <path> | all', 'all');

// in listCommand:
const cwdMode = opts.cwd ?? 'all';
const here = process.cwd();
const filter = cwdMode === 'all'    ? () => true
            : cwdMode === 'current' ? (e) => e.cwd === here
            : cwdMode === 'auto'    ? (e) => e.cwd === here
            : (e) => e.cwd === cwdMode;
let entries = (await listSessions(source)).filter(filter);
if (cwdMode === 'auto' && entries.length === 0) {
  entries = await listSessions(source);   // fall back to global
  // emit meta.cwd_scope = "fellback_to_global"
}
```

Apply identical wiring to `search`.

## Verification

```bash
sessionr list --cwd current --output json | jq '.sessions | map(.cwd) | unique'
# expect a single-element array of $PWD
```

## Related

- [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]
- [[discovery/05-MEDIUM-source-not-validated]]
