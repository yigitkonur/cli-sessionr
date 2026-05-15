# 01 · CRITICAL · `prune --yes` reports `status: "ok", deleted: [...]` but never deletes anything

**Context:** destructive · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/prune.ts:79-92`

## Evidence

```ts
// src/commands/prune.ts:79-92
// Note: actual deletion depends on source adapters supporting delete.
// For now, report what would be deleted — actual file deletion is source-specific.
const result = {
  api_version: 1,
  status: 'ok',
  deleted: toDelete.map((e) => ({
    id: e.id,
    source: e.source,
    file_path: e.filePath,
  })),
  count: toDelete.length,
};
console.log(JSON.stringify(result, dateReplacer, 2));
```

The comment in the code admits the truth. The output **lies**: `status: "ok"`, `deleted: [...]`, `count: N` — but no `unlink` is performed, no adapter is called, the files remain on disk.

## Why this fails an agent (worst kind of failure)

Destructive commands have a stronger contract than read commands: the agent must be able to trust that "deleted" means deleted. Today:

1. Agent runs `sessionr prune --older-than 30d --yes --output json`.
2. Receives `status: ok, deleted: [42 items]`.
3. Treats those 42 IDs as gone, drops them from a tracking table.
4. Ten minutes later runs `sessionr list` and sees them again.
5. Either: re-prunes (infinite loop), or: panics about a "phantom restore" that never happened.

A no-op disguised as a destructive success is the single worst error class in the skill's severity rubric.

## Fix

Three valid options, in order of preference:

1. **Implement deletion**. Add `deleteSession(filePath)` to `SourceAdapter`. Most sources are file-backed JSONL — `unlinkSync` is enough. Goose/Zed need SQLite `DELETE FROM ...`. Acceptable scope: implement for `claude`, `codex`, `gemini`, `copilot`, `cursor-agent`, `commandcode`, `opencode`, `kiro` (file-backed). Skip Goose/Zed and emit `partial_unsupported_sources: ["goose","zed"]`.
2. **Refuse**. Until deletion lands, change `prune --yes` to throw:
   ```
   {ok:false, error:{class:"internal", code:"NOT_IMPLEMENTED", message:"prune --yes is not yet implemented; use --dry-run to preview"}}
   ```
3. **Honest no-op**. Return `status: "preview_only"`, `deleted: []`, `would_delete: [...]`, and clear it in the success path. Document that the only working mode is `--dry-run`.

Whichever path you pick, **ship it before any agent uses `prune --yes`**. This is a footgun.

## Verification

After the fix:

```bash
N=$(sessionr list --output json | jq '.sessions | length')
sessionr prune --older-than 999d --yes --output json | jq .count
N2=$(sessionr list --output json | jq '.sessions | length')
test "$N" -ge "$N2"   # must shrink (or count must be 0 with refusal)
```

## Related

- [[errors/02-HIGH-send-plain-text-stderr-errors]] (similar trust break in send)
- [[destructive/02-MEDIUM-no-dry-run-on-send]]
