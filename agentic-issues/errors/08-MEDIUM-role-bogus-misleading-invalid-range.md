# 08 · MEDIUM · `--role bogus` filters to 0 messages, then errors with the misleading `INVALID_RANGE`

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:172-175`, `src/slicer.ts` (filterByRole)

## Evidence

Probe `_probes/49_read_bad_role.txt`: `read <id> --role bogus --output json` → exit 2 with `INVALID_RANGE`. The error message says "messages 1-0 requested" — confusing because the actual fault was an unknown role.

## Fix

Validate roles before filtering:

```ts
const VALID_ROLES = new Set(['user','assistant','system','tool_use','tool_result']);
if (opts?.role) {
  const roles = opts.role.split(',').map(r => r.trim()).filter(Boolean);
  const unknown = roles.filter(r => !VALID_ROLES.has(r));
  if (unknown.length > 0) {
    throw new SessionReaderError(`Unknown role(s): ${unknown.join(', ')}`, {
      code: 'INVALID_ROLE', exitCode: EXIT.USAGE,
      detail: { provided: roles, unknown, valid: [...VALID_ROLES] },
      suggestion: `sessionr read <id> --role user,assistant`,
    });
  }
  messages = filterByRole(messages, roles);
}
```

## Verification

```bash
sessionr read <id> --role banana --output json 2>&1 | jq '.error.code'   # expect "INVALID_ROLE"
```

## Related

- [[discovery/14-LOW-no-preset-detail-anchor-validation]]
