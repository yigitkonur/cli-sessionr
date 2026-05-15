# 15 · LOW · No batch / multi-session read — agents pay one CLI invocation per session

**Context:** iterative · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts`, `src/commands/read.ts`

Comparative analysis ("read these 5 sessions, summarize each") forces 5 invocations. Each `npx sessionr` startup is dominated by Node.js + Commander cold start (~150 ms apiece).

## Fix

Add a batch mode that streams JSONL one session at a time:

```bash
sessionr read --batch ids.txt --tokens 2000 --output jsonl
# emits: {type:'meta', api_version, count}\n
#         {type:'session', id, ...}\n  (per session — repeats)
#         {type:'message', session_id, …}\n  (per message)
```

Re-uses the existing parsers and slicer — purely an emitter change.

## Verification

```bash
echo -e "abc\ndef\nghi" > /tmp/ids.txt
sessionr read --batch /tmp/ids.txt --output jsonl --tokens 1000 | head -20
```
