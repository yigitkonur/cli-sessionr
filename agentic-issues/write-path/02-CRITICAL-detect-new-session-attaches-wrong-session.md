# 02 · CRITICAL · `detectNewSession` may return an unrelated recent session ID

**Context:** write-path · **Severity:** Critical · **Status:** open
**Owners:** `src/commands/send.ts:279-291`

This is the write-path slice of [[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]]. Same root cause, different lens. The fix lives in destructive/03.

The TL;DR: `entries.find(cwd === cwd) ?? entries[0]?.id` can attach the agent to **any** recent session if the just-created one isn't visible yet. Drop the fallback; poll briefly; otherwise fail with `EXIT.PARTIAL` so the caller knows.

Severity is **critical** because it leaks one project's prompts into another project's history.
