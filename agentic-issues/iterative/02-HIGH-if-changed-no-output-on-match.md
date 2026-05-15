# 02 · HIGH · `--if-changed` exits 42 with **no JSON body** — breaks stateless polling

**Context:** iterative · **Severity:** High · **Status:** open
**Owners:** `src/cli.ts:104-117`

## Evidence

```ts
// src/cli.ts:104-117
if (etag === readOpts.ifChanged) {
  process.exitCode = 42;
  return;     // ← no console.log, no JSON
}
```

Probe `_probes/50_read_etag_bad.txt`: `--if-changed abc` (mismatched) returns the full body (correct). On match, stdout is empty, exit is 42. Agent has nothing to parse and can't even confirm the etag echoed back.

## Why this fails an agent

Stateless polling requires every response to be self-describing. An agent that runs `read --if-changed <etag>` and sees empty stdout has to special-case exit 42 in its read pipeline — a deviation from the "always parse JSON" contract.

## Fix

Always emit a small envelope:

```ts
if (etag === readOpts.ifChanged) {
  process.stdout.write(JSON.stringify({
    ok: true,
    schema_version: 'v1',
    result: { unchanged: true, session_id: s.id, source: s.source },
    meta: { etag, total_messages: s.stats.totalMessages, updated_at: s.metadata.updatedAt },
    actions: [
      { command: `sessionr read ${s.id} --if-changed ${etag}`, description: 'Poll again' },
      { command: `sessionr read ${s.id}`, description: 'Bypass etag and fetch' },
    ],
  }, null, 2) + '\n');
  process.exitCode = EXIT.NO_CHANGES;   // 42 still distinguishes the case
  return;
}
```

## Verification

```bash
ETAG=$(sessionr --output json read <id> | jq -r .meta.etag)
sessionr --output json read <id> --if-changed "$ETAG" | jq .result.unchanged   # expect true
echo $?                                                                       # expect 42
```

## Related

- [[iterative/01-HIGH-etag-not-in-read-response]]
- [[errors/04-MEDIUM-exit-codes-mostly-unused]]
