# 03 · HIGH · ETag is computed from session content only — pagination/preset/budget collisions

**Context:** iterative · **Severity:** High · **Status:** open
**Owners:** `src/etag.ts`

## Evidence

`computeETag(session)` (read `src/etag.ts`) hashes session-level fields (typically `updatedAt + totalMessages` or similar). It does **not** include:

- the `--preset`/`--detail` choice
- the `--tokens` budget
- the requested `--from`/`--to`/`--page`/`--anchor`/`--search` slice
- the formatter (`json` vs `jsonl`)

Two `read` calls with the same session id but different preset/budget/range produce different bodies but the **same** etag.

## Why this fails an agent

An agent caches a `read --tokens 2000` body keyed on the etag, then later issues `read --tokens 8000 --if-changed <same-etag>` expecting more data — the server says "unchanged", agent uses the stale 2000-token slice.

## Fix

Hash all the inputs that affect the rendered body:

```ts
import { createHash } from 'node:crypto';
export function computeETag(s: NormalizedSession, opts: {
  preset?: string; tokenBudget?: number; from?: number; to?: number;
  anchor?: string; search?: string; page?: number; format?: string;
}): string {
  const h = createHash('sha256');
  h.update(s.metadata.updatedAt.toISOString());
  h.update('|' + s.stats.totalMessages);
  h.update('|' + (opts.preset ?? ''));
  h.update('|' + (opts.tokenBudget ?? ''));
  h.update('|' + (opts.from ?? '') + '..' + (opts.to ?? ''));
  h.update('|' + (opts.anchor ?? '') + ':' + (opts.search ?? ''));
  h.update('|' + (opts.page ?? ''));
  h.update('|' + (opts.format ?? ''));
  return h.digest('hex').slice(0, 16);
}
```

Pass the same `opts` from `cli.ts` and `read.ts`.

## Verification

```bash
E1=$(sessionr --output json read <id> --tokens 2000 | jq -r .meta.etag)
E2=$(sessionr --output json read <id> --tokens 8000 | jq -r .meta.etag)
test "$E1" != "$E2" && echo OK
```

## Related

- [[iterative/01-HIGH-etag-not-in-read-response]]
- [[iterative/02-HIGH-if-changed-no-output-on-match]]
