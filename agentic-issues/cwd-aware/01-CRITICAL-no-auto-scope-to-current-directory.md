# 01 · CRITICAL · `sessionr list` ignores `$PWD` — no auto-scope to current project

**Context:** cwd-aware · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/list.ts`, `src/discovery.ts`, `src/cli.ts`

> User's stated #1 ask:
> *"I want it to work directly inside the working directory I'm running it from, and first show the active sessions there… or if there's nothing there, I want it to detect and surface the errors automatically."*

## Evidence

- `src/cli.ts:44-58` — `list` accepts only `[source]`, `--limit`, `--offset`, `--search`. **No `--cwd` flag** and no implicit cwd scoping.
- `src/discovery.ts:45-76` — `listSessions(source?, limit?)` walks every adapter globally and sorts by `updatedAt` desc; `cwd` exists on each `SessionListEntry` (`src/types.ts:81-88`) but is never used as a filter.
- `src/commands/list.ts:23` — `await listSessions(source as SessionSource | undefined)` passes through with no cwd input.
- Probe `_probes/04_list_json.txt`: from inside `/Users/yigitkonur/dev/cli-sessionr` the first 20 entries span `/Users/yigitkonur/dev/codex-bridge`, `/saas-zeoradar`, `/website-zeo`, `/saas-wope-ai`, `/lets-talk`, `/Users/yigitkonur` — none of the surfaced entries are guaranteed to be from the agent's own repo. The agent has to download every entry, parse it, then filter client-side. With ~3,400 sessions globally that is wasteful and racy.
- Probe `_probes/73_list_from_tmp.txt`: running the same command from `/tmp` returns the identical global list — the binary has zero awareness of where it is invoked.

## Why this fails an agent

Sub-agents (Claude Code, Codex, Gemini CLI, etc.) are spawned *inside* a project working directory. Their first natural question is *"what other agents have worked on **this** project?"*. Today they get a global list of 20 most-recent sessions across the user's entire machine. To find their own repo's history they must:

1. List many pages.
2. Parse each entry's `cwd`.
3. Filter manually.
4. Re-issue `read` on the filtered IDs.

This burns tokens and turns a 1-step lookup into a 4-step fan-out. Worse, it routinely misses **the relevant session entirely** when a noisy adjacent project has had many recent runs and pushes the desired one off page 1.

## Fix

1. Add `--cwd <auto|current|all|<path>>` to `list`, `read --search`, `search`, and `info`. Default = `auto`.
2. `auto` semantics — applied in `listSessions`:
   - Filter to entries where `entry.cwd === process.cwd()`.
   - If the filtered set is **non-empty**, return it sorted by recency.
   - If the filtered set is **empty**, return the global list **with** a meta flag `cwd_scope: "fellback_to_global", cwd: "<pwd>", reason: "no sessions matched cwd"` so the agent can react instead of being silently lied to.
3. Always include `meta.cwd` and `meta.cwd_scope` in the JSON envelope so the agent can prove which mode produced the list.
4. Update help & footer (TTY) to advertise the auto-scope: *"Showing sessions from `~/dev/lets-talk`. Use `--cwd all` for global."*
5. Repeat for `loadSession` ID resolution: when an `<id>` prefix matches multiple sessions across different `cwd`s, prefer the one in `process.cwd()`; emit `prefix_matches[]` in the error otherwise so the agent can pick.

## Verification

```bash
cd /Users/yigitkonur/dev/cli-sessionr
sessionr list --output json | jq '.meta.cwd_scope, .meta.cwd, (.sessions | length)'
# expect "auto" "/Users/yigitkonur/dev/cli-sessionr" >0

cd /tmp && sessionr list --output json | jq '.meta.cwd_scope, .sessions[0].cwd'
# expect "fellback_to_global" — and a clear `next_action.command` to retry with --cwd all

sessionr list --cwd all --output json | jq '.meta.cwd_scope'
# expect "all"
```

## Related

- [[discovery/01-HIGH-no-cwd-filter-on-list]] (filter-side perspective)
- [[discovery/08-MEDIUM-list-footer-only-one-tip]] (footer should advertise scope)
- [[output-contracts/07-HIGH-envelope-shape-drift]] (envelope must surface the new meta)
