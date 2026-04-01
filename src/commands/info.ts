import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

export async function infoCommand(
  sessionId: string,
  opts: { source?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY: process.stdout.isTTY ?? false,
  });

  try {
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );
    console.log(formatter.stats(session));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}
