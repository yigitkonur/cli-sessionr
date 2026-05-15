# 16 · LOW · `--timing` is accepted but **never emits** `timing_ms`

**Context:** output-contracts · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts:28`

## Evidence

`src/cli.ts:28`:
```ts
.option('--timing', 'Include timing_ms in JSON responses')
```

`grep -rn 'timing_ms\|timing' src/` returns only the flag definition. No emitter ever adds `timing_ms` to the envelope. Setting `--timing` is a no-op.

## Why this fails an agent

Agents auto-tuning per-command latency (e.g. picking `--tokens` to fit a deadline) need wall-clock measurements. The CLI advertises an opt-in for that information and silently lies.

## Fix

```ts
// inject into every emitter:
const start = process.hrtime.bigint();
// …work…
const ms = Number(process.hrtime.bigint() - start) / 1e6;
if (program.opts().timing) {
  (envelope.meta ??= {}).timing_ms = Math.round(ms);
}
```

## Verification

```bash
sessionr --timing --output json list -n 1 | jq '.meta.timing_ms'   # expect a number
sessionr --output json list -n 1 | jq '.meta.timing_ms'            # expect null
```

## Related

- [[output-contracts/15-LOW-api-version-flag-is-dead]]
