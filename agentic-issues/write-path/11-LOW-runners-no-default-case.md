# 11 · LOW · `buildResumeCommand` / `buildNewCommand` switches lack exhaustiveness checks

**Context:** write-path · **Severity:** Low · **Status:** open
**Owners:** `src/runners.ts:8-64`

When a new `SessionSource` is added, both functions silently return `undefined` from any unhandled case (no compile error). Add the `never` exhaustiveness pattern after the switch:

```ts
const _exhaustive: never = source;
throw new SessionReaderError(`Unsupported source: ${_exhaustive}`, {code:'UNSUPPORTED_SOURCE', exitCode: EXIT.USAGE});
```

Also document in `AGENTS.md` that adding a new source requires updates in both functions.

(This is the upstream root cause of [[write-path/01-CRITICAL-send-deadbeef-undefined-cmd-crash]], but worth its own entry.)
