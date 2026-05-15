# 15 · LOW · `--api-version <n>` is accepted but **never read** anywhere

**Context:** output-contracts · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts:27`

## Evidence

`src/cli.ts:27` defines:
```ts
.option('--api-version <n>', 'API version for structured output', '1')
```

A `grep -rn 'apiVersion\|api-version\|api_version' src/` shows the flag is defined and the literal `api_version: 1` is hardcoded in every emitter — but the flag value is **never read**. Setting `--api-version 999` returns the same `api_version: 1` envelope.

## Why this fails an agent

An agent that wants to opt into a future v2 envelope (e.g., the unified envelope from [[output-contracts/07-HIGH-envelope-shape-drift]]) has nothing to set. The flag advertises a contract that doesn't exist.

## Fix

Either:

1. Implement it. Use it as the gate for the v2 envelope migration.
2. Remove it until it's needed.

Pick (1). One-line wiring:

```ts
const apiVersion = Number(program.opts().apiVersion);
if (![1, 2].includes(apiVersion)) {
  throw new SessionReaderError(`Unknown --api-version "${apiVersion}". Supported: 1, 2.`, {
    code: 'UNSUPPORTED_API_VERSION', exitCode: EXIT.USAGE,
  });
}
// pass apiVersion into every command so the emitter knows which envelope to produce
```

## Verification

```bash
sessionr --api-version 999 list 2>&1 | jq .error.code   # expect "UNSUPPORTED_API_VERSION"
sessionr --api-version 2 --output json list | jq '.schema_version'   # expect "v2" once implemented
```

## Related

- [[output-contracts/07-HIGH-envelope-shape-drift]]
- [[output-contracts/16-LOW-timing-flag-is-dead]]
