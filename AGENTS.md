# AGENTS.md

## What This Is

`sessionr` is a zero-install CLI tool (`npx sessionr`) that reads AI coding sessions from 10 tools and shows statistics + messages with configurable verbosity. Designed for AI agents to inspect other agents' sessions.

## Commands

```bash
pnpm install          # Install deps
pnpm build            # tsc → dist/
pnpm test             # vitest run
pnpm dev -- <args>    # Run via tsx (no build)
```

Direct execution during development:
```bash
./node_modules/.bin/tsx src/cli.ts list
./node_modules/.bin/tsx src/cli.ts stats <session-id>
./node_modules/.bin/tsx src/cli.ts read <session-id> [from] [to] -p <preset>
./node_modules/.bin/tsx src/cli.ts stats <session-id> --json
```

## Architecture

```
CLI (src/cli.ts)
  → Discovery (src/discovery.ts)
    → Registry (src/parsers/registry.ts)
      → Parsers (src/parsers/*.ts)
        → Output Formatters (src/output/*.ts)
```

### Core Flow

1. **CLI** — Commander.js with 3 subcommands: `stats`, `read`, `list`
2. **Discovery** — imports `src/parsers/index.ts` (barrel that triggers all `registerSource()` calls), searches all registered sources in parallel via `Promise.allSettled`
3. **Registry** — `SourceAdapter` interface with `{name, label, color, find(), parse()}`. Each parser registers itself at module load
4. **Parsers** — one file per tool, each exports `findXxxSessions()` and `parseXxxSession()`, plus calls `registerSource()`
5. **Output** — 3 formatters (JSON, plain markdown, colored TTY) dispatched by `createFormatter({json, isTTY})`

### Key Types (`src/types.ts`)

- `SessionSource` — union of 10 tool names
- `NormalizedMessage` — 1-based indexed message with `role`, `content`, `blocks: ContentBlock[]`, `timestamp`
- `ContentBlock` — discriminated union: `text | thinking | tool_use | tool_result`
- `NormalizedSession` — `{id, source, filePath, metadata, messages, stats}`
- `SessionStats` — `{totalMessages, byRole, byBlockType, tokenUsage, toolFrequency, filesModified, durationMs}`
- `VerbosityPreset` — controls truncation per preset (minimal/standard/verbose/full)

### Message Explosion Model

Tool blocks inside assistant/user messages are **exploded** into separate `NormalizedMessage` entries. A Claude assistant message with `[text, tool_use, tool_use]` becomes 3 messages: one `assistant` (text) + two `tool_use`. This lets the `read` command address any message by index.

### Shared Explosion Logic (`src/parsers/explosion.ts`)

`explodeAssistantBlocks()` and `explodeUserBlocks()` are shared by Claude and Command Code parsers (identical content block format). Import from here — don't duplicate.

## Supported Sources

| Source | Parser | Storage | Format |
|--------|--------|---------|--------|
| `claude` | `claude.ts` | `~/.claude/projects/*/UUID.jsonl` | JSONL |
| `codex` | `codex.ts` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |
| `gemini` | `gemini.ts` | `~/.gemini/tmp/*/chats/session-*.json` | JSON |
| `copilot` | `copilot.ts` | `~/.copilot/session-state/<id>/` | YAML+JSONL |
| `cursor-agent` | `cursor-agent.ts` | `~/.cursor/projects/*/agent-transcripts/*.jsonl` | JSONL |
| `commandcode` | `commandcode.ts` | `~/.commandcode/projects/*/*.jsonl` | JSONL |
| `goose` | `goose.ts` | `~/.local/share/goose/sessions/` | SQLite+JSONL |
| `opencode` | `opencode.ts` | `~/.local/share/opencode/storage/` | JSON files |
| `kiro` | `kiro.ts` | `~/.kiro/User/globalStorage/kiro.kiroagent/` | JSON |
| `zed` | `zed.ts` | `~/Library/Application Support/Zed/threads/threads.db` | SQLite+zstd |

## Adding a New Parser

1. Create `src/parsers/newtool.ts` exporting:
   - `findNewtoolSessions(): Promise<SessionListEntry[]>`
   - `parseNewtoolSession(filePath: string): Promise<NormalizedSession>`
   - Call `registerSource({name, label, color, find, parse})` at module level
2. Add `'newtool'` to `SessionSource` union in `src/types.ts`
3. Add `import './newtool.js'` to `src/parsers/index.ts`

That's it — discovery, CLI, and formatters are registry-driven.

## Verbosity Presets (`src/config.ts`)

| Preset | Content | Tool Args | Tool Results | Thinking |
|--------|---------|-----------|-------------|----------|
| `minimal` | 80 chars | hidden | hidden | hidden |
| `standard` | 500 chars | 60 chars | 80 chars | hidden |
| `verbose` | 2000 chars | 200 chars | 500 chars | 200 chars |
| `full` | unlimited | full JSON | unlimited | unlimited |

## Testing

- Tests: `__tests__/parsers.test.ts`, `__tests__/config.test.ts`
- Fixtures: `__tests__/fixtures/codex-session.jsonl`, `__tests__/fixtures/claude-session.jsonl`
- Run single: `npx vitest run __tests__/parsers.test.ts`
- Fixture convention: realistic JSONL/JSON matching real tool formats, 10-20 lines covering all event types

## Conventions

- **ESM-only** — `"type": "module"`, all imports use `.js` extensions
- **Node 18+** — no `node:sqlite` dependency (used optionally for Goose/Zed on Node 22+)
- **2 runtime deps only** — `chalk` (v4, CJS+ESM) + `commander` (v14). Do not add more.
- **No Zod at runtime** — use type guards, not schema validation
- **`process.exitCode = 1`** — never call `process.exit()` directly
- **Session data is read-only** — never modify source session files
- **Parsers skip bad lines silently** — try/catch in `readJsonlFile`, don't crash on malformed data
- **Empty messages show `[empty]`** — never render blank output under a message header
