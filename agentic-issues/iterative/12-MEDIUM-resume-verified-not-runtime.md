# 12 · MEDIUM · `next_action.verified` is hardcoded — does not check whether the binary is actually on `PATH`

**Context:** iterative · **Severity:** Medium · **Status:** open
**Owners:** `src/resume.ts`

`verified: true|false` is baked into the `TOOL_DIRECTS` table. It says nothing about whether `claude`/`codex`/`gemini` is currently installed on the user's machine.

## Why this fails an agent

Agents that branch on `verified === true` (e.g. "safe to spawn") will spawn a binary that doesn't exist, get `ENOENT`, and fail unnecessarily. They could have detected the missing binary via the resume hint instead.

## Fix

Resolve binaries lazily and cache per process:

```ts
import { resolve as resolvePath } from 'node:path';
import { execSync } from 'node:child_process';
const binCache = new Map<string, boolean>();
function binExists(bin: string): boolean {
  if (!binCache.has(bin)) {
    try { execSync(`command -v ${bin}`); binCache.set(bin, true); }
    catch { binCache.set(bin, false); }
  }
  return binCache.get(bin)!;
}
…
verified: tool && binExists(tool.bin),
```

(For Windows compatibility use `where` instead of `command -v`, or `which-cli`.)

## Verification

```bash
PATH=/nonexistent sessionr --output json read <id> | jq '.meta.next_action.verified'
# expect false
```

## Related

- [[discovery/07-MEDIUM-no-doctor-command]]
- [[write-path/05-HIGH-kiro-resume-command-broken]]
