# Troubleshooting

Triage in this order: which command, which exit, which `error.code`. Each section starts with a one-line symptom and goes deeper from there.

## "List returns empty"

1. `sessionr doctor --output json | jq '.result.sources[] | {name, data_dir_exists, session_count}'` — the first row tells you whether the source you expected was even installed here.
2. Check `meta.cwd_scope` in your original `list` envelope. If it's `auto` and you got nothing, sessionr already fell back to global; the tool truly has nothing.
3. If `--cwd current` gave nothing but you've definitely worked here: the tool's session file may record a different cwd than `$PWD` (symlink, container path mapping, `cd ~/dev/repo` vs `cd /Users/.../dev/repo`). Try `--cwd all` and grep the result for partial cwd matches.
4. Check `meta.warnings[]` — if an adapter rejected (e.g. `zed: zstd missing`), that source's sessions were skipped silently except for the warning.

## "SESSION_NOT_FOUND"

Exit 3. Three sub-cases:

**(a) Prefix is ambiguous.** `error.detail.prefix_matches[]` lists candidates. Pick by source or cwd, then re-issue with a longer prefix or `--source`.

**(b) Prefix is wrong.** Maybe the user typoed. Try `sessionr list -q "<expected first words>" --output json` to find by content.

**(c) The session was deleted.** Most likely the user ran `rm` against the file, or the source's tool rotated/cleared its history. Run `sessionr doctor` to confirm the data dir still exists.

## "INVALID_SOURCE"

The source name isn't in the 11 known. `error.detail.valid` lists them. Common typos:

- `claud` → `claude`
- `gpt` / `gpt-5` → there's no GPT source; closest is `codex`
- `cursor` → `cursor-agent`
- `command-code` / `cmd-code` → `commandcode`
- `droid` → resolves to `factory` (alias works)

Aliases that DO resolve: `cc`, `cli`, `copilot-cli`, `cx`, `gm`, `droid`.

## "INVALID_PRESET / INVALID_ROLE / INVALID_ANCHOR"

Validation errors with `detail.valid` listing accepted values.

- Presets: `minimal`, `standard`, `verbose`, `full`.
- Roles: `user`, `assistant`, `system`, `tool_use`, `tool_result`.
- Anchors: `head`, `tail`, `search`. Note: `--anchor search` requires `--search`.

## "PARTIAL exit (10)"

Not a failure. The body is valid JSON. The slice was truncated by the token budget.

- Check `meta.partial = true`, `meta.has_more_after = true`, `meta.cursor.next` for the next page.
- To get more in one shot: raise `--tokens N` (max ~8000).
- To traverse linearly: use `meta.cursor.next` (it's a copy-paste-ready command).
- Or use `--page N` for explicit pagination.

## "JOB_TIMEOUT"

Wait exceeded `--timeout` seconds. The job is still running — it was the wait that gave up.

- Wait again with `--timeout <2x>` (sessionr's own suggestion caps at 1 hour).
- Or `sessionr cancel <job_id>` and inspect `~/.sessionreader/jobs/<job_id>.stderr` for what the tool was doing.

## "TOOL_ERROR (exit 1) on send"

The spawned tool (`claude`/`codex`/`gemini`/etc.) exited non-zero. `error.detail.stderr_tail` carries the last 50 lines of its stderr. Common causes:

- Auth: tool says "not logged in" or 401. Run the tool's own login command.
- Quota: API rate limit or out-of-credits. Surface to user.
- Tool crashed. Check the full stderr in `~/.sessionreader/jobs/<id>.stderr` (async) or re-run with `--output text` to see live (sync).

## "SPAWN_ERROR" (binary not on PATH)

The tool's binary isn't installed or isn't on PATH for the shell sessionr spawns. `sessionr doctor` will report `spawn_bin_resolvable: false` for that source.

Fix: install the tool, OR `which <bin>` and adjust PATH, OR use `sessionr send --new -s <other-source>` if the user is open to a different tool.

## "NEW_SESSION_NOT_DETECTED" (exit 10)

`send --new` succeeded (tool exited 0) but no new session file appeared in `$PWD` within the ~2s polling window. Usually a flush race.

- Sleep 1s, then `sessionr list --cwd current --source <source> -n 5 --output json`.
- The new session is probably there now; pick it up by `id`.
- This is `retry: true` — one retry is fine.

## "UNSUPPORTED_OPERATION" (exit 2)

You tried `sessionr send <kiro-id>`. Kiro's CLI can't target a specific session. Use `sessionr send --new -s kiro -m "..."` to start a fresh kiro session.

## "UNSUPPORTED_SOURCE" (exit 2)

You tried `sessionr send <zed-id>`. Zed's AI threads are GUI-only. Pick a CLI-based source.

## "NOT_IMPLEMENTED" on `prune --yes`

Sessionr's `prune --yes` currently refuses to actually delete (would otherwise lie about success). Use `--dry-run` to inspect the cutoff list and delete files manually until a future release implements adapter-level deletion.

## "Help command exits 2"

Pre-2.7.1 bug: `--output json help` reported exit 2 even on success. Upgrade to 2.7.1+.

## "--version reports the wrong number"

Pre-2.7.1 bug: `program.version()` was hardcoded so semantic-release bumps shipped binaries that lied about their own version. Upgrade to 2.7.1+. Easy verification:

```bash
npx sessionr@latest --version    # should match `npm view sessionr@latest version`
```

## "JSON has unexpected fields / missing fields"

Top-level shape varies by command (info/stats are flat; send sync uses `meta`, send async uses `data`; prune-dry-run uses `would_delete`). See `references/json-envelope.md` "envelope cheat-sheet" for the per-command map.

A `--api-version 2` is reserved for a unified envelope; today, code defensively against the per-command shape.

## "I see colored prose instead of JSON"

You're getting TTY-detection mode. Force JSON by either:

- `--output json` flag, OR
- `SESSIONR_OUTPUT=json` env var, OR
- `SESSIONR_AGENT=1` env var (forces JSON regardless of TTY status).

Setting `SESSIONR_AGENT=1` once at the top of an agent script is the cleanest pattern.

## "Adapter warning blocking the result"

`meta.warnings[]` carries adapter-level rejections (e.g. `zed: zstd missing`). The other sources still ran; only the rejected adapter contributed nothing. Surface the warning to the user; do not silently drop.

To fix the underlying issue:

- `goose` warnings about `node:sqlite` → upgrade to Node 22.5+.
- `zed` warnings about `zstd` → install `zstd` system binary (`brew install zstd` on macOS).
- Other parser errors → run sessionr from the cli-sessionr repo with the failing fixture and file an issue.

## "I'm reading a 100k-message session and the agent is OOMing"

Three lines of defense:

1. Use `--tokens 4000` (or smaller) — this caps the slice.
2. Use `--detail meta` for a structural overview without content.
3. Use `--batch` for many sessions but `--page` to stream within a single huge one.

## Version drift

Recent breaking-ish changes:

- v2.7.0: `--cwd <scope>` removed from `list` (was duplicate). Now only `--cwd <mode>`.
- v2.7.1: version-string fix (binary now reports correct `--version`).
- v2.8.0: anchor messages (#1 and last) never truncated regardless of preset.
- v2.8.1: anchor rule refined to "leading system/user run + last assistant message".

If you see surprising behavior on an older version, `npm install -g sessionr@latest` and retry.
