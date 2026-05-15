# 05 · HIGH · `kiro` resume command passes `message` where the tool expects no second argument

**Context:** write-path · **Severity:** High · **Status:** open
**Owners:** `src/runners.ts:31`, `src/resume.ts:51-54`

## Evidence

```ts
// src/runners.ts:31 (kiro resume)
return { bin: 'kiro-cli', args: ['chat', '--no-interactive', '--resume', message] };

// src/resume.ts:52
kiro: {
  cmd: () => `kiro-cli chat --no-interactive --resume`,   // no sessionId, no message
  verified: false,
  tip: 'Kiro resumes most recent session in cwd (cannot target by ID)',
},
```

The runners pass `message` as the value of `--resume` (kiro-cli reads it as the resume target, not as a message). The resume hint admits Kiro "cannot target by ID" yet `runners.ts` tries to pass an ID-shaped string anyway.

## Why this fails an agent

The agent invokes `sessionr send <kiro-id> -m "go"` thinking it will resume that session and append "go". Instead `kiro-cli` receives `--resume "go"` and either (a) parses "go" as a session ID and fails, (b) treats "go" as a flag and prompts for input, or (c) opens the wrong session.

## Fix

Pick the correct shape and align all three layers (`runners.ts`, `resume.ts`, integration test):

```ts
// if Kiro CLI does support targeting:
case 'kiro':
  return { bin: 'kiro-cli', args: ['chat', '--no-interactive', '--resume', sessionId, message] };

// if Kiro CLI does NOT support targeting:
case 'kiro':
  // there is no way to target — refuse rather than silently misroute
  throw new SessionReaderError('Kiro CLI cannot resume a specific session', {
    code: 'UNSUPPORTED_OPERATION', exitCode: EXIT.USAGE,
    suggestion: 'sessionr send --new --source kiro -m "..."',
  });
```

Also re-audit `cursor-agent` (`runners.ts:21`) for `--resume <id>` vs `--resume=<id>` per the parallel audit.

## Verification

Manual: run `kiro-cli chat --no-interactive --help` to confirm exact resume syntax, then re-run sessionr send.

## Related

- [[iterative/12-MEDIUM-resume-verified-not-runtime]]
