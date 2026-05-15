# 08 · HIGH · No `ok` boolean and no `schema_version` string in any envelope

**Context:** output-contracts · **Severity:** High · **Status:** open
**Owners:** all output emitters

## Evidence

Grep for `"ok": true` or `schema_version` in `src/`: zero results. Every success response infers success from absence of `error`; every error response infers failure from presence of `error`.

`api_version: 1` exists at the top of most envelopes but is a **number**, mixes API protocol with schema version, and is hardcoded everywhere — `--api-version` flag never reads it (see [[output-contracts/15-LOW-api-version-flag-is-dead]]).

## Why this fails an agent

`if ('error' in resp)` is fragile: it breaks the moment a command legitimately includes the word "error" in a nested data field (e.g. `tool_result` blocks where `isError: true`). Agents need a top-level boolean to check before they reach for the rest of the payload. They also need a stable `schema_version` so they can recognize when a future release introduces breaking changes.

## Fix

Add to every envelope:

```jsonc
{
  "ok": true,                  // required, top-level
  "schema_version": "v1",      // required, semver-ish string — bump on breaking change
  "result": {…},               // present iff ok===true
  "error": {…},                // present iff ok===false
  "meta": {…},                 // optional, common pagination/etag/cwd
  "actions": [{command, description, …}]  // optional
}
```

Make these fields **required** in the schema; leave `api_version` for one deprecation cycle.

## Verification

```bash
sessionr --output json list | jq 'has("ok") and has("schema_version")'  # expect true
sessionr --output json read deadbeef 2>&1 | jq '.ok == false and has("error")'  # expect true
```

## Related

- [[output-contracts/07-HIGH-envelope-shape-drift]]
