// Suppress Node's `ExperimentalWarning: SQLite is an experimental feature`.
//
// The goose/zed parsers lazily `require('node:sqlite')` (Node 22+). On Node 22
// that emits an ExperimentalWarning to STDERR the first time it's loaded —
// which pollutes the stderr channel that the v2 contract (oc/04) promises is
// clean in JSON mode. An agent checking stderr for errors would otherwise see
// this noise on every command that touches the parser registry.
//
// We intercept `process.emit('warning', ...)` and swallow ONLY this specific
// experimental warning. All other warnings pass through untouched. Imported
// first in cli.ts so the filter is active before any parser loads node:sqlite.

type EmitArgs = [event: string | symbol, ...args: unknown[]];

const originalEmit = process.emit.bind(process);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emit = function patchedEmit(...args: EmitArgs): boolean {
  const [event, data] = args;
  if (
    event === 'warning' &&
    data &&
    typeof data === 'object' &&
    (data as Error).name === 'ExperimentalWarning' &&
    /\bSQLite\b/i.test((data as Error).message ?? '')
  ) {
    return false; // swallow — keep stderr clean for agents
  }
  return (originalEmit as (...a: EmitArgs) => boolean)(...args);
};
