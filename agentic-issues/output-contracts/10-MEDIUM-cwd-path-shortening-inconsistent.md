# 10 · MEDIUM · Path shortening (`~/…`) is applied by `read` and `info` but not by `list`

**Context:** output-contracts · **Severity:** Medium · **Status:** open
**Owners:** `src/commands/read.ts:32`, `src/commands/info.ts:35`, `src/commands/list.ts:49`

## Evidence

- `read` envelope: `session.cwd = "~/dev/cli-sessionr"` (line 32, `shortenPath()`).
- `info` envelope: `cwd = "~/dev/cli-sessionr"` (line 35, `shortenPath()`).
- `list` envelope: `cwd = "/Users/yigitkonur/dev/cli-sessionr"` (line 49, raw `entry.cwd`).

Probes `_probes/04_list_json.txt` (full path) vs `_probes/51_info_ok.txt` (`~/`) confirm.

## Why this fails an agent

An agent storing sessions by `cwd` builds a dedup map keyed on the path. The same session shows up under two keys depending on which command produced the record. Cross-command joins (e.g. `list → for each .id, info`) silently break.

Path shortening is also lossy when `$HOME` is unusual (CI runners, root-owned home dirs, container layers).

## Fix

Pick one and apply everywhere. Recommend **always emit absolute paths** in JSON. Let the formatter shorten for TTY display only. Add `cwd_short` as a TTY-only convenience field if needed, but never replace `cwd` in machine output.

```ts
// in every JSON emitter:
cwd: session.metadata.cwd,        // absolute, raw
// drop shortenPath() on JSON emitters; keep it inside tty.ts/plain.ts
```

## Verification

```bash
sessionr --output json list | jq '.sessions[0].cwd' | grep -v '^"~'
sessionr --output json read <id> | jq '.session.cwd' | grep -v '^"~'
sessionr --output json info <id> | jq '.cwd' | grep -v '^"~'
# all three must succeed (no ~ in any cwd field)
```

## Related

- [[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]
