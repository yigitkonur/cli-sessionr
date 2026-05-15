# 01 · HIGH · `read` never returns the computed `etag` — agents can't poll with `--if-changed`

**Context:** iterative · **Severity:** High · **Status:** open
**Owners:** `src/commands/read.ts:284-309`, `src/output/json.ts:23-65`

## Evidence

`computeETag(session)` exists in `src/etag.ts` and is consumed in `src/cli.ts:104-117` to short-circuit `--if-changed`. Search for `etag` in `src/commands/read.ts` and `src/output/json.ts`: zero matches in the response envelope. The `read` envelope returns no `etag` field.

## Why this fails an agent

`--if-changed <etag>` requires the agent to know the previous etag. With no etag in the response, the agent has no way to obtain one — the polling feature is effectively unreachable from a clean start. Agents either skip `--if-changed` entirely (re-fetching every time) or compute a hash of the body locally (defeats the purpose).

## Fix

Compute and emit `etag` on every `read` response:

```ts
import { computeETag } from '../etag.js';
const etag = computeETag(session, preset?.name, tokenBudget);  // see iterative/03 for inputs
envelope.meta.etag = etag;
// or, top-level: envelope.etag = etag;
```

Same for `info`, `stats`, `context` if/when those become pollable.

## Verification

```bash
ETAG=$(sessionr --output json read <id> | jq -r '.meta.etag // .etag')
sessionr --output json read <id> --if-changed "$ETAG" | jq '.unchanged // .meta.etag'
# expect "unchanged: true" then a fresh etag if the session was modified
```

## Related

- [[iterative/02-HIGH-if-changed-no-output-on-match]]
- [[iterative/03-HIGH-etag-omits-preset-budget]]
