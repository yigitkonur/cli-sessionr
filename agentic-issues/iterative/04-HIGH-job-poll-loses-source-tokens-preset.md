# 04 · HIGH · `send → job → wait → read` loop loses `--source`, `--tokens`, `--preset`

**Context:** iterative · **Severity:** High · **Status:** open
**Owners:** `src/commands/send.ts`, `src/commands/job.ts`

## Evidence

When `send <id> --source claude --tokens 4000 --preset verbose --async` finishes, the suggested follow-up is:

```
sessionr read <id> --after <message_count_before>
```

(`src/commands/job.ts:35-39`, `src/commands/send.ts:209-211`.) None of `--source`, `--tokens`, `--preset` are carried into the suggested command. The agent must remember them.

## Why this fails an agent

Long-running flows (`send --async → wait → read`) are exactly the scenario where the agent has lost mid-flight context (subagent boundary, tool restart). The CLI is the system of record for the original parameters; it should propagate them.

## Fix

1. Persist the original `send` options on the job record.
2. Echo them back into every `next_action.command` from `job`, `wait`, and `cancel`.

```ts
// src/jobs.ts (CreateJobInput)
interface CreateJobInput {
  …
  read_back: { source: SessionSource, tokens?: number, preset?: string };
}

// src/commands/job.ts
actions.push({
  command: `sessionr read ${session_id} --after ${message_count_before} ` +
           `--source ${j.read_back.source}` +
           (j.read_back.tokens ? ` --tokens ${j.read_back.tokens}` : '') +
           (j.read_back.preset ? ` --preset ${j.read_back.preset}` : ''),
  description: 'Read new messages with the original send settings',
});
```

## Verification

```bash
JID=$(sessionr send --new -s claude --tokens 4000 --preset verbose --async -m hi --output json | jq -r .data.job_id)
sessionr wait $JID --output json | jq '.actions[].command' | grep -E '--source claude.*--tokens 4000.*--preset verbose'
```

## Related

- [[iterative/05-MEDIUM-list-cursor-no-numeric-tokens]]
- [[iterative/13-LOW-jobstatus-no-cancelled]]
