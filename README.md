# sessionr

one command. your agent reads another agent's session. paginated, token-aware, structured.

```bash
npx sessionr session list
```

no install. no daemon. no config. just run it.

---

## the story

i kept copy-pasting between agents. claude finishes a task, i paste the output into codex. codex writes code, i paste it back into gemini for review. every handoff was me being the clipboard.

so i built a thing. a cli that lets one agent directly read another agent's session — the raw messages, tool calls, thinking blocks, everything. no copy-paste. just `npx sessionr session read <id>`.

then it grew. agents needed to paginate through long sessions without blowing their context window, so i added token-aware slicing. they needed different detail levels, so i added presets — `minimal` gives you 80-char previews, `full` gives you everything including thinking blocks. the agent picks what it needs.

then i added resume hints. every read response tells the agent exactly how to continue that session — the exact cli command, verified against the tool's actual `--help` output. so an agent doesn't just read, it knows how to pick up where the other one left off.

and then i thought: if the agent knows the resume command... why not just run it? so i added `session send`. your agent can now send a message to another agent's session and get back only the new messages. sync by default, `--async` if you want to fire-and-forget and check back later.

that's when it stopped being a session reader and became an agent orchestrator. fan out three agents in parallel, wait for all of them, read just the deltas. no workflow engine. no message bus. no daemon. just a cli you call with `npx`.

the whole thing is ~250kb, two runtime deps (chalk + commander), works on node 18+, reads from 10 different ai tools. you install nothing. you configure nothing. you just pipe json.

## what it reads

| tool | storage | format |
|------|---------|--------|
| claude code | `~/.claude/projects/` | jsonl |
| codex cli | `~/.codex/sessions/` | jsonl |
| gemini cli | `~/.gemini/tmp/` | json |
| github copilot | `~/.copilot/session-state/` | yaml+jsonl |
| cursor agent | `~/.cursor/projects/` | jsonl |
| command code | `~/.commandcode/projects/` | jsonl |
| goose | `~/.local/share/goose/sessions/` | sqlite+jsonl |
| opencode | `~/.local/share/opencode/storage/` | json |
| kiro | `~/.kiro/User/globalStorage/` | json |
| zed | `~/Library/Application Support/Zed/` | sqlite+zstd |

all auto-discovered. no config file. no env vars. it just finds them.

## install

you don't. just run:

```bash
npx sessionr session list
```

or if you want it around:

```bash
npm i -g sessionr
```

## commands

### read path

```bash
# list all sessions across all tools
sessionr session list

# list only claude sessions
sessionr session list claude

# read a session
sessionr session read <id>

# read with a token budget (agent-friendly — won't blow your context)
sessionr session read <id> --tokens 4000

# read just the tail (default) or the head
sessionr session read <id> --tokens 4000 --anchor tail
sessionr session read <id> --tokens 4000 --anchor head

# search within a session and expand around the match
sessionr session read <id> --tokens 4000 --search "database migration"

# filter by role
sessionr session read <id> --role user,assistant

# cursor pagination
sessionr session read <id> --after 15
sessionr session read <id> --before 30

# detail levels — pick how much your agent sees
sessionr session read <id> --detail full        # everything
sessionr session read <id> --detail condensed   # standard truncation
sessionr session read <id> --detail skeleton    # 60-char previews
sessionr session read <id> --detail meta        # just indices and roles

# verbosity presets — fine control
sessionr session read <id> --preset minimal     # 80 chars, no tools
sessionr session read <id> --preset standard    # 500 chars (default)
sessionr session read <id> --preset verbose     # 2000 chars + thinking
sessionr session read <id> --preset full        # unlimited everything

# conditional read (skip if nothing changed)
sessionr session read <id> --if-changed <etag>
# exit code 42 = no changes. your agent saves tokens.

# stats
sessionr session stats <id>

# search across all sessions
sessionr session search -q "TypeError"

# compare two sessions
sessionr session diff <id1> <id2>

# export context for agent handoff
sessionr context export <id> --tokens 8000
```

### write path

```bash
# send a message to an existing session (sync — blocks until done)
sessionr session send <id> -m "now translate that to turkish"
# returns only the NEW messages. your agent gets the delta, not the whole history.

# create a new session
sessionr session send --new --source claude -m "list all .py files"

# async mode — fire and forget
sessionr session send <id> -m "refactor the auth module" --async
# returns a job id immediately

# check if it's done
sessionr job status <job-id>

# block until done
sessionr job wait <job-id> --timeout 120

# cancel
sessionr job cancel <job-id>

# list all jobs
sessionr job list
sessionr job list --status running
```

### real scenarios

**agent reads another agent's work:**
```bash
sessionr session list codex --output json
# pick the session id from the response
sessionr session read <id> --tokens 4000 --role assistant --output json
```

**iterative conversation:**
```bash
# first message
sessionr session send --new --source claude -m "analyze this codebase for security issues"
# response includes session_id

# follow-up
sessionr session send <session-id> -m "focus on the sql injection risks"

# another
sessionr session send <session-id> -m "generate a fix for the worst one"
```

**parallel fan-out:**
```bash
# launch 3 reviews in parallel
sessionr session send --new --source claude -m "review auth module" --async    # => job1
sessionr session send --new --source codex -m "review db module" --async       # => job2
sessionr session send --new --source gemini -m "review api endpoints" --async  # => job3

# wait for all
sessionr job wait <job1>
sessionr job wait <job2>
sessionr job wait <job3>

# read the deltas
sessionr session read <id1> --after 0 --tokens 2000
sessionr session read <id2> --after 0 --tokens 2000
sessionr session read <id3> --after 0 --tokens 2000
```

**cross-tool review loop:**
```bash
# codex writes code
sessionr session send --new --source codex -m "implement caching layer" --cwd /project

# export context for reviewer
sessionr context export <codex-session> --tokens 6000

# claude reviews
sessionr session send --new --source claude -m "review this: $(sessionr context export <codex-session>)"

# feed review back
sessionr session send <codex-session> -m "apply these comments: $(sessionr session read <claude-session> --role assistant)"
```

## output

everything is json when piped, colored text when interactive. override with `--output json|jsonl|text|table`.

every json response has `api_version: 1` and an `actions` array telling the agent what to do next:

```json
{
  "api_version": 1,
  "meta": {
    "session_id": "abc123",
    "total_messages": 45,
    "returned_tokens_estimate": 3800,
    "token_budget": 4000,
    "has_more_before": true,
    "cursor_before": 29,
    "next_action": {
      "description": "Continue this Claude Code session",
      "interactive": "claude -r abc123",
      "non_interactive": "claude -p -r abc123 \"your follow-up\"",
      "verified": true
    }
  },
  "messages": [...]
}
```

your agent never has to guess what to do next. the response tells it.

## exit codes

| code | meaning |
|------|---------|
| 0 | ok |
| 1 | error |
| 2 | bad usage |
| 3 | not found |
| 42 | no changes (etag match) |

structured errors too:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session not found: abc123",
    "suggestion": "sessionr session list --output json",
    "retry": false
  }
}
```

## env vars

| var | what it does |
|-----|-------------|
| `SESSIONREADER_OUTPUT` | default output format |
| `SESSIONREADER_MAX_TOKENS` | default token budget |
| `SESSIONREADER_AGENT=true` | force agent mode |

## how it works

```
cli (commander.js)
  → discovery (auto-finds sessions from all 10 tools)
    → parsers (one per tool, normalize everything to the same shape)
      → slicer (token-aware pagination with head/tail/search anchors)
        → formatters (json / jsonl / text / tty)
```

messages are "exploded" — a claude assistant response with `[text, tool_use, tool_use]` becomes 3 separate messages. every message has a stable 1-based index. tool blocks, thinking blocks, text blocks — all normalized into the same `ContentBlock` union type.

token estimation is heuristic (3.5 chars/token for code, 4.0 for prose). no tiktoken dependency. good enough for budgeting.

job tracking is file-based (`~/.sessionreader/jobs/`). no daemon. pid liveness is checked lazily on every `job status` call via `process.kill(pid, 0)`. when the pid is dead, the job is finalized.

## the point

your agent shouldn't need you to be the clipboard. it should read the other agent's session directly, at whatever detail level it needs, within whatever token budget it has, and know exactly how to continue the conversation.

that's it. that's the whole thing.

```bash
npx sessionr session list
```

## license

mit
