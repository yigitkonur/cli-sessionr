# T07 Send Spawn Pipes Capture Audit

## Scope

- Updated only the synchronous `sessionr send` spawn path.
- Left the asynchronous job path unchanged; it already writes child output to log files.

## Implementation

- `spawnAndWait` keeps `stdio: ['ignore', 'pipe', 'pipe']`.
- Child `stdout` and `stderr` are drained with `data` listeners and mirrored to parent `stderr`.
- Each stream keeps a 50-line tail buffer, including a final unterminated line on process close.
- The spawn promise uses `child.once(...)` handlers and a `settled` guard so it resolves or rejects once.
- Non-zero tool exits include `stderr_tail` and `stdout_tail` in the `TOOL_ERROR` detail when available.

## Verification

- Added a Vitest regression that runs a real child process, verifies mirrored output, and checks 50-line tail capture.
- `pnpm build`
- `pnpm test`
