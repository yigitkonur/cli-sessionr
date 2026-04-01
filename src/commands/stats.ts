import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

export async function statsCommand(
  sessionId: string,
  opts: { source?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const { messages: _messages, ...rest } = session;
      const result: Record<string, unknown> = {
        api_version: 1,
        ...rest,
        actions: [
          { command: `sessionr read ${session.id}`, description: 'Read session messages' },
          { command: `sessionr send ${session.id} -f prompt.md --source ${session.source}`, description: 'Resume session' },
          { command: `sessionr context ${session.id} --tokens 8000`, description: 'Export context for agent handoff' },
          { command: `sessionr diff ${session.id} <other-id>`, description: 'Compare with another session' },
          { command: `sessionr tag ${session.id} --add important`, description: 'Tag this session' },
          { command: `sessionr prune --older-than 7d --dry-run`, description: 'Preview cleanup of old sessions' },
        ],
      };
      console.log(JSON.stringify(result, dateReplacer, 2));
    } else {
      console.log(formatter.stats(session));
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
