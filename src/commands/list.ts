import { listSessions } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

const SOURCES = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed'];

export async function listCommand(
  source?: string,
  opts?: { limit?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat = opts?.output ?? (opts?.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts?.output,
    json: opts?.json,
    isTTY,
  });

  try {
    const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
    const allEntries = await listSessions(source as SessionSource | undefined);
    const entries = allEntries.slice(0, limit);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const result: Record<string, unknown> = {
        api_version: 1,
        sessions: entries,
        total_available: allEntries.length,
        limit,
        has_more: allEntries.length > limit,
        available_sources: SOURCES,
      };

      const actions: Array<{ command: string; description: string }> = [];
      if (entries.length > 0) {
        actions.push(
          { command: `sessionr read ${entries[0].id} --tokens 4000`, description: 'Read most recent session' },
          { command: `sessionr stats ${entries[0].id}`, description: 'Show session statistics' },
        );
      }
      if (allEntries.length > limit) {
        actions.push(
          { command: `sessionr list --limit ${limit + 20}`, description: 'Show more sessions' },
        );
      }
      result.actions = actions;

      console.log(JSON.stringify(result, dateReplacer, 2));
    } else {
      console.log(formatter.list(entries));
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
