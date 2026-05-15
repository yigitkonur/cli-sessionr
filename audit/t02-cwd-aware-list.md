# t02 cwd-aware list

## Change

`sessionr list` now defaults to `--cwd auto`.

In `auto` mode, sessions whose `cwd` equals `process.cwd()` are returned first as the scoped result. If no sessions match the current directory, the command falls back to the global list and reports that fallback in the JSON envelope.

`sessionr search` mirrors the same `--cwd <auto|current|all|path>` flag and metadata.

## JSON contract

- `meta.cwd_scope: "auto"` when auto mode found current-directory sessions.
- `meta.cwd_scope: "fellback_to_global"` when auto mode found no current-directory sessions and returned the global list.
- `meta.cwd_scope: "all"` for `--cwd all`.
- `meta.cwd_scope: "explicit"` for `--cwd current` or an explicit path.
- `meta.cwd` is the absolute cwd used for matching.
- JSON `cwd` fields in `list`, `search`, `read`, and `info` use raw absolute paths; human formatters keep their own path shortening.
