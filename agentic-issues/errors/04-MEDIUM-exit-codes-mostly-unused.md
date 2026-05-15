# 04 · MEDIUM · Of 8 declared exit codes, only 4 are emitted — `AUTH`, `RATE_LIMITED`, `PARTIAL` are dead

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/errors.ts:1-10`

## Evidence

```ts
export const EXIT = {
  OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 3, AUTH: 4,
  RATE_LIMITED: 5, PARTIAL: 10, NO_CHANGES: 42,
};
```

A grep across `src/`:

- `EXIT.OK` — implicit (default exitCode 0).
- `EXIT.ERROR` — many uses.
- `EXIT.USAGE` — many uses.
- `EXIT.NOT_FOUND` — only `SessionNotFoundError`, `JOB_NOT_FOUND` in `job.ts`.
- `EXIT.AUTH` — **0 uses**.
- `EXIT.RATE_LIMITED` — **0 uses**.
- `EXIT.PARTIAL` — **0 uses**.
- `EXIT.NO_CHANGES` — used once in `cli.ts` for `--if-changed`.

## Why this fails an agent

Agents write retry logic against the exit-code map advertised in `--output json help`. Three codes are reserved-but-never-emitted:

- `AUTH` (4) is documented but no command checks credentials. Agents have no signal for "tool not authenticated".
- `RATE_LIMITED` (5) is documented but never raised, even when `send` calls `claude` and `claude` hits a 429.
- `PARTIAL` (10) is most damaging: when `read` truncates results because of token budget, exit is 0 — the agent thinks it has the full session.

## Fix

Wire each:

1. **`PARTIAL`**: in `read.ts`, after `sliceByTokenBudget`, if the slice is shorter than the requested range OR `meta.has_more_before || has_more_after`, set:
   ```ts
   process.exitCode = EXIT.PARTIAL;
   meta.partial = true;
   ```
   Document that 10 means "valid response but truncated; check `meta.has_more_*`".

2. **`AUTH`**: when `send` spawns a tool and that tool exits with the auth-failure code (claude=401-style, codex's own code, gemini's own code), translate to `EXIT.AUTH` with `class:"auth"`. Suggestion field: "run `<tool> login`".

3. **`RATE_LIMITED`**: same translation pattern for 429-equivalent exits.

## Verification

```bash
sessionr read <huge-session-id> --tokens 200 --output json; echo $?
# expect: exit 10, meta.partial=true, has_more_after=true
```

## Related

- [[errors/09-MEDIUM-no-retry-semantics]]
- [[discovery/09-LOW-exit-codes-not-in-human-help]]
