import { listSessions, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

const SOURCES = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed'];

export async function listCommand(
  source?: string,
  opts?: { limit?: string; offset?: string; search?: string; json?: boolean; output?: OutputFormat },
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
    const offset = opts?.offset ? parseInt(opts.offset, 10) : 0;
    let allEntries = await listSessions(source as SessionSource | undefined);

    // Content search across sessions
    if (opts?.search) {
      const query = opts.search.toLowerCase();
      const matched: typeof allEntries = [];
      for (const entry of allEntries.slice(0, 50)) {
        try {
          const session = await loadSession(entry.id, entry.source);
          const hasMatch = session.messages.some(
            (m) => m.content.toLowerCase().includes(query),
          );
          if (hasMatch) matched.push(entry);
        } catch {
          // skip unparseable sessions
        }
      }
      allEntries = matched;
    }

    const entries = allEntries.slice(offset, offset + limit);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const hasMore = offset + limit < allEntries.length;
      const result: Record<string, unknown> = {
        api_version: 1,
        sessions: entries,
        total_available: allEntries.length,
        limit,
        offset,
        has_more: hasMore,
        available_sources: SOURCES,
      };

      // Cursor commands
      const cursor: Record<string, string | null> = {
        next: hasMore
          ? `sessionr list${source ? ' ' + source : ''} --offset ${offset + limit} --limit ${limit}`
          : null,
        prev: offset > 0
          ? `sessionr list${source ? ' ' + source : ''} --offset ${Math.max(0, offset - limit)} --limit ${limit}`
          : null,
      };
      result.cursor = cursor;

      const actions: Array<{ command: string; description: string }> = [];
      if (entries.length > 0) {
        actions.push(
          { command: `sessionr read ${entries[0].id}`, description: 'Read most recent session' },
          { command: `sessionr stats ${entries[0].id}`, description: 'Full statistics (tools, tokens, files)' },
        );
      }
      actions.push(
        { command: `sessionr list --search "keyword"`, description: 'Search sessions by content' },
        { command: `sessionr send --new -s claude -f prompt.md`, description: 'Start new session' },
      );
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
