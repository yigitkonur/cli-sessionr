# 11 · MEDIUM · `dateReplacer` not used uniformly — date fields can serialize as `{}` or be omitted

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** every JSON emitter

## Evidence

`dateReplacer` is a private helper duplicated in at least seven files (`list.ts`, `read.ts`, `send.ts`, `info.ts`, `prune.ts`, `output/json.ts`, `output/jsonl.ts`). Most call sites use it; some don't:

- `src/commands/tag.ts:75` — `JSON.stringify(result, null, 2)` (no replacer).
- `src/commands/job.ts:53,118,149,160,209` — `JSON.stringify(result, null, 2)` (no replacer).
- `src/commands/context.ts` — relies on internally-built strings; if a Date leaks, it serializes as `{}`.

`Date` instances JSON-serialize to ISO strings only via `Date.prototype.toJSON`. If the codebase ever subclasses or wraps a Date, or if a `null` slips into a date field, the JSON has no chance of recovering. Different parts of the code disagree on the replacer.

## Why this fails an agent

An agent compares `session.updated_at` from `list` against `job.started_at` from `jobs`. Both are strings most of the time — but as soon as one path drops a Date that wasn't passed through `Date.prototype.toJSON` (e.g., a Luxon DateTime or a custom Time class added later), the agent gets `{}` and the comparison silently returns `false`.

## Fix

1. Move `dateReplacer` to a shared `src/output/serialize.ts`.
2. Re-export a `stringify(obj)` helper that always uses it.
3. Replace every `JSON.stringify(_, null, 2)` in command emitters with `stringify(_)`.
4. Add a one-line test: a payload containing `{when: new Date(0)}` round-trips to `"1970-01-01T00:00:00.000Z"` from every command.

## Verification

```bash
sessionr --output json job whatever 2>&1 | jq '.error.detail.started_at // "n/a"'  # never null
sessionr --output json tag <id> --add foo | jq '.tags[]'                            # not [object Object]
```

## Related

- none directly; this is a hygiene issue.
