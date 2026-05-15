# 08 · MEDIUM · `send --async` does not set `process.exitCode` explicitly

**Context:** write-path · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/send.ts:217-277`

`runAsync` prints the JSON envelope and returns. `process.exitCode` is left at its default (0). That is correct for the spawn-success case but conflates with the silent error case where `mkdirSync` or `createWriteStream` fails earlier — in those paths the catch in `sendCommand` may set a different code, but the async branch itself never makes the success-vs-failure intent explicit.

## Fix

After successful spawn, set `process.exitCode = EXIT.OK` explicitly. On any failure inside `runAsync` (spawn fails, mkdir fails, file open fails), throw `SessionReaderError` so the standard catch path sets a non-zero code.

## Verification

```bash
sessionr send --new -s claude --async -m hi; echo $?    # expect 0
chmod -w ~/.sessionreader/jobs && sessionr send --new -s claude --async -m hi; echo $?
# expect non-zero with a real error envelope
```
