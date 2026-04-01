import { listSessions } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

export async function listCommand(
  source?: string,
  opts?: { limit?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const formatter = createFormatter({
    output: opts?.output,
    json: opts?.json,
    isTTY: process.stdout.isTTY ?? false,
  });

  try {
    const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
    const entries = await listSessions(
      source as SessionSource | undefined,
      limit,
    );
    console.log(formatter.list(entries));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}
