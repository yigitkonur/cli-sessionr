# 10 · MEDIUM · `spawn` error event vs. close event can both fire — promise resolution race

**Context:** write-path · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/send.ts:293-318`

The promise registers both `child.on('error', reject)` and `child.on('close', resolve)`. In rare cases (binary exists but immediately fails to exec), both fire. The current code resolves with whichever comes first; a subsequent `reject` is a no-op but the rejection logic for `SPAWN_ERROR` may be skipped.

## Fix

Use a single-resolution pattern and `child.once`. Or migrate to `child_process.execFile`/`spawnSync` for the sync path.

```ts
return new Promise((resolve, reject) => {
  let settled = false;
  const settle = (fn: typeof resolve | typeof reject, v: unknown) => { if (settled) return; settled = true; fn(v as never); };
  child.once('error', (err) => settle(reject, new SessionReaderError(...)));
  child.once('close', (code) => settle(resolve, code ?? 1));
});
```

## Verification

Hard to reproduce without injection; cover with a mocked child via vitest.
