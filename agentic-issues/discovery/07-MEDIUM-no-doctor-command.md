# 07 · MEDIUM · No `doctor` / `version --verbose` — agents can't diagnose missing tools or empty data dirs

**Context:** discovery · **Severity:** Medium · **Status:** open
**Owners:** `src/cli.ts`, new file `src/commands/doctor.ts`

## Evidence

`-V` returns the bare version string. There's no command that reports:

- which source adapters are registered
- which target binary each adapter would `spawn` (`claude`, `codex`, …) and whether it's resolvable on PATH
- which data directories exist on disk and how many sessions live there
- which optional dependencies (`node:sqlite` for Goose/Zed on Node 22+, `zstd` for Zed) are available

Agents and humans both have to guess when `sessionr list` returns empty: "no sessions yet" vs "data dir missing" vs "adapter crashed and `Promise.allSettled` swallowed it".

## Why this fails an agent

When the agent sees `sessions: []`, the rational next step is `sessionr doctor` to learn whether the empty result is correct or an environmental failure. Today the agent has to reverse-engineer adapter expectations from the source.

## Fix

Add a non-hidden `doctor` command that returns one row per adapter:

```jsonc
{
  "ok": true,
  "schema_version": "v1",
  "result": {
    "node_version": "v22.3.0",
    "sessionr_version": "2.5.4",
    "cwd": "/Users/.../lets-talk",
    "sources": [
      {
        "name": "claude",
        "data_dir": "/Users/yigitkonur/.claude/projects",
        "data_dir_exists": true,
        "session_count": 142,
        "spawn_bin": "claude",
        "spawn_bin_resolvable": true,
        "spawn_bin_path": "/usr/local/bin/claude"
      },
      …
    ],
    "warnings": ["zed: zstd binary not found, zed sessions cannot be parsed"]
  }
}
```

Then update `SessionNotFoundError.suggestion` (`src/errors.ts:59`) to recommend `sessionr doctor` when the search returns nothing.

## Verification

```bash
sessionr doctor --output json | jq '.result.sources | map(select(.session_count==0))'
sessionr doctor --output json | jq '.result.sources | map(.spawn_bin_resolvable) | all'
```

## Related

- [[discovery/01-HIGH-no-cwd-filter-on-list]]
- [[discovery/13-MEDIUM-error-suggestions-too-generic]]
