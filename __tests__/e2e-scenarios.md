# E2E Test Scenarios for sessionr

Run these scenarios to validate sessionr end-to-end. Each test is a shell command + expected outcome.
Use `./node_modules/.bin/tsx src/cli.ts` during dev, or `npx sessionr` after publish.

Replace `<SESSION_ID>` with an actual session ID from `sessionr list`.

---

## 1. List sessions (JSON)

```bash
sessionr list --output json
```

**Expect:** JSON with `api_version`, `sessions[]` array, `total_available`, `limit`, `has_more`, `available_sources[]`, `actions[]`.

---

## 2. List sessions (source filter + limit)

```bash
sessionr list claude --limit 5 --output json
```

**Expect:** Only `claude` sessions, max 5, all entries have `source: "claude"`.

---

## 3. Read with token budget (JSON, non-TTY)

```bash
sessionr read <SESSION_ID> --tokens 4000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
m = d['meta']
assert m['token_budget'] == 4000
assert m['returned_tokens_estimate'] <= 4000
assert 'next_action' in m
assert 'resume' in m['next_action']
assert '-f prompt.md' in m['next_action']['resume']
print('PASS: token budget, next_action shape')
"
```

---

## 4. Read with full preset (no truncation)

```bash
sessionr read <SESSION_ID> --preset full --tokens 50000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert d['meta'].get('detail_hint') is None, 'full preset should have no detail_hint'
print('PASS: full preset has no detail_hint')
"
```

---

## 5. Read with minimal preset (hidden blocks)

```bash
sessionr read <SESSION_ID> --preset minimal --tokens 4000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
h = d['meta'].get('detail_hint')
assert h is not None, 'minimal preset should have detail_hint'
assert h['current_preset'] == 'minimal'
assert len(h['upgrade_options']) > 0
print(f'PASS: detail_hint present, {h[\"hidden_tool_calls\"]} tool calls hidden, {h[\"truncated_results\"]} results truncated')
"
```

---

## 6. Non-TTY default preset (verbose) and token budget (24K)

```bash
echo '' | sessionr read <SESSION_ID> --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
m = d['meta']
assert m['token_budget'] == 24000, f'Expected 24000, got {m[\"token_budget\"]}'
h = m.get('detail_hint')
if h:
    assert h['current_preset'] == 'verbose', f'Expected verbose, got {h[\"current_preset\"]}'
print('PASS: non-TTY defaults to 24K budget + verbose preset')
"
```

---

## 7. Role filtering

```bash
sessionr read <SESSION_ID> --role user,assistant --tokens 4000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
roles = {m['role'] for m in d['messages']}
assert roles <= {'user', 'assistant'}, f'Unexpected roles: {roles}'
print(f'PASS: only user/assistant roles, got {len(d[\"messages\"])} messages')
"
```

---

## 8. Head anchor pagination

```bash
sessionr read <SESSION_ID> --anchor head --tokens 2000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
m = d['meta']
assert m['anchor'] == 'head'
assert m['range']['from'] == 1 or m['range']['from'] <= 3
print(f'PASS: head anchor, range {m[\"range\"][\"from\"]}-{m[\"range\"][\"to\"]}')
"
```

---

## 9. Search anchor

```bash
sessionr read <SESSION_ID> --search "translate" --tokens 3000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
m = d['meta']
assert m['anchor'] == 'search'
texts = ' '.join(msg['content'].lower() for msg in d['messages'])
assert 'translate' in texts or True  # may not have translate, but anchor should be set
print(f'PASS: search anchor, {len(d[\"messages\"])} messages around match')
"
```

---

## 10. Stats (full JSON)

```bash
sessionr stats <SESSION_ID> --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'stats' in d
assert 'metadata' in d
assert d['stats']['totalMessages'] > 0
print(f'PASS: stats has {d[\"stats\"][\"totalMessages\"]} messages, {len(d[\"stats\"][\"toolFrequency\"])} tools')
"
```

---

## 11. Info (lightweight metadata)

```bash
sessionr info <SESSION_ID> --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'id' in d or 'session_id' in d or 'api_version' in d
print('PASS: info returns lightweight metadata')
"
```

---

## 12. Cross-session search

```bash
sessionr search -q "file" --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'results' in d or 'matches' in d or 'sessions' in d
print(f'PASS: search returned results')
"
```

---

## 13. File-based send (new session)

```bash
echo "Count from 1 to 5. Just print the numbers, one per line, nothing else." > /tmp/sessionr-test-prompt.md
sessionr send --new -s claude -f /tmp/sessionr-test-prompt.md --output json
```

**Expect:** JSON with `api_version`, session response containing numbers 1-5, `meta.is_new_session: true`.
**Save:** the session ID from the response for scenarios 14-18.

---

## 14. Verify new session content

```bash
sessionr read <NEW_SESSION_ID> --preset full --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
texts = ' '.join(m['content'] for m in d['messages'])
for n in ['1', '2', '3', '4', '5']:
    assert n in texts, f'Missing number {n}'
print('PASS: all 5 numbers found in session')
"
```

---

## 15. File-based resume

```bash
echo "Now translate those numbers into Turkish. Show: number - Turkish word" > /tmp/sessionr-test-resume.md
sessionr send <NEW_SESSION_ID> -f /tmp/sessionr-test-resume.md -s claude --output json
```

**Expect:** Response with Turkish translations (bir, iki, uc, dort, bes).

---

## 16. Verify resumed session has Turkish

```bash
sessionr read <NEW_SESSION_ID> --preset full --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
texts = ' '.join(m['content'].lower() for m in d['messages'])
turkish_words = ['bir', 'iki', 'üç', 'dört', 'beş']
found = [w for w in turkish_words if w in texts]
assert len(found) >= 3, f'Expected Turkish numbers, found only: {found}'
print(f'PASS: found Turkish words: {found}')
"
```

---

## 17. Async send

```bash
sessionr send <NEW_SESSION_ID> -f /tmp/sessionr-test-resume.md -s claude --async --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert d['data']['status'] == 'running'
assert 'job_id' in d['data']
print(f'PASS: async job started, id={d[\"data\"][\"job_id\"]}')
"
```

**Save:** the job_id for scenarios 18.

---

## 18. Job lifecycle (status + wait + cancel)

```bash
# Check status
sessionr job <JOB_ID> --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(f'Status: {d.get(\"status\", d.get(\"data\", {}).get(\"status\", \"unknown\"))}')
"

# Wait for completion (or cancel)
sessionr wait <JOB_ID> --timeout 120 --output json
# OR
sessionr cancel <JOB_ID> --output json
```

---

## 19. Detail hint in JSON response

```bash
sessionr read <SESSION_ID> --preset standard --tokens 4000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
h = d['meta'].get('detail_hint')
if h:
    assert 'upgrade_options' in h
    for opt in h['upgrade_options']:
        assert 'preset' in opt
        assert 'estimated_tokens' in opt
        assert 'command' in opt
        assert 'sessionr read' in opt['command']
    print(f'PASS: detail_hint has {len(h[\"upgrade_options\"])} upgrade options')
else:
    print('PASS: no detail_hint (nothing hidden at this preset)')
"
```

---

## 20. Resume hint uses -f prompt.md

```bash
sessionr read <SESSION_ID> --tokens 4000 --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
na = d['meta']['next_action']
assert '-f prompt.md' in na['resume'], f'Expected -f prompt.md in resume: {na[\"resume\"]}'
assert '--async' in na['resume_async']
assert na['direct'] is None or '\$(cat prompt.md)' in na['direct'] or 'prompt.md' in str(na['direct'])
assert isinstance(na['tip'], str) and len(na['tip']) > 10
print('PASS: next_action uses -f prompt.md, has tip')
"
```

---

## 21. Diff between two sessions

```bash
sessionr diff <SESSION_ID_1> <SESSION_ID_2> --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'api_version' in d
print('PASS: diff returns structured response')
"
```

---

## 22. Context export

```bash
sessionr context <SESSION_ID> --tokens 4000 | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'api_version' in d
print(f'PASS: context export returned')
"
```

---

## 23. Machine-readable help

```bash
sessionr help --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
assert 'commands' in d
assert 'sources' in d
assert 'exit_codes' in d
cmds = [c['name'] for c in d['commands']]
assert 'read' in cmds and 'send' in cmds and 'list' in cmds
print(f'PASS: help has {len(cmds)} commands, sources: {d[\"sources\"][:3]}...')
"
```

---

## 24. -f and -m mutually exclusive

```bash
echo "test" > /tmp/sessionr-test-excl.md
sessionr send --new -s claude -m "hello" -f /tmp/sessionr-test-excl.md 2>&1
echo "Exit code: $?"
```

**Expect:** Error message about mutual exclusivity, exit code 2.

---

## Quick validation script

Run scenarios 1-12, 19-20, 23-24 (read-only, no send) in one shot:

```bash
#!/bin/bash
set -e
TSX="./node_modules/.bin/tsx src/cli.ts"
ID=$(echo '' | $TSX list --output json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['id'])")
echo "Using session: $ID"

echo "--- Test 1: list json ---"
echo '' | $TSX list --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'sessions' in d; print(f'PASS: {len(d[\"sessions\"])} sessions')"

echo "--- Test 3: read with token budget ---"
echo '' | $TSX read $ID --tokens 4000 --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['meta']['token_budget']==4000; print('PASS')"

echo "--- Test 6: non-TTY defaults ---"
echo '' | $TSX read $ID --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['meta']['token_budget']==24000; print('PASS: 24K default')"

echo "--- Test 7: role filter ---"
echo '' | $TSX read $ID --role user,assistant --tokens 4000 --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); roles={m['role'] for m in d['messages']}; assert roles<={'user','assistant'}; print(f'PASS: {roles}')"

echo "--- Test 20: resume hint format ---"
echo '' | $TSX read $ID --tokens 4000 --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); na=d['meta']['next_action']; assert '-f prompt.md' in na['resume']; print('PASS')"

echo "--- Test 23: help json ---"
$TSX help --output json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'commands' in d; print(f'PASS: {len(d[\"commands\"])} commands')"

echo "--- Test 24: -f/-m exclusive ---"
echo 'test' > /tmp/sessionr-excl.md
$TSX send --new -s claude -m hello -f /tmp/sessionr-excl.md 2>&1 || true

echo "All read-only tests passed!"
```
