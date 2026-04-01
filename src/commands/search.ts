import { listSessions, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat, SessionListEntry } from '../types.js';

interface SearchResult extends SessionListEntry {
  matchCount: number;
}

export async function searchCommand(
  opts: {
    query: string;
    source?: string;
    top?: string;
    maxSessions?: string;
    json?: boolean;
    output?: OutputFormat;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    const maxSessions = opts.maxSessions ? parseInt(opts.maxSessions, 10) : 20;
    const allEntries = await listSessions(opts.source as SessionSource | undefined);
    const entries = allEntries.slice(0, maxSessions);
    const query = opts.query.toLowerCase();
    const top = opts.top ? parseInt(opts.top, 10) : 10;
    const results: SearchResult[] = [];

    for (const entry of entries) {
      try {
        const session = await loadSession(entry.id, entry.source);
        let matchCount = 0;
        for (const msg of session.messages) {
          if (msg.content.toLowerCase().includes(query)) {
            matchCount++;
          }
        }
        if (matchCount > 0) {
          results.push({ ...entry, matchCount });
        }
      } catch {
        // skip sessions that fail to parse
      }
    }

    results.sort((a, b) => b.matchCount - a.matchCount);
    const topResults = results.slice(0, top);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const actions: Array<{ command: string; description: string }> = [];
      if (topResults.length > 0) {
        actions.push(
          { command: `sessionr read ${topResults[0].id} --search "${opts.query}" --tokens 4000`, description: 'Read top match with context' },
        );
      }
      if (allEntries.length > maxSessions) {
        actions.push(
          { command: `sessionr search -q "${opts.query}" --max-sessions ${maxSessions + 20}`, description: 'Search more sessions' },
        );
      }

      const result = {
        api_version: 1,
        query: opts.query,
        sessions_scanned: entries.length,
        sessions_available: allEntries.length,
        results: topResults.map((r) => ({
          id: r.id,
          source: r.source,
          cwd: r.cwd,
          updatedAt: r.updatedAt,
          summary: r.summary,
          match_count: r.matchCount,
        })),
        total_matches: topResults.length,
        actions,
      };
      console.log(JSON.stringify(result, dateReplacer, 2));
    } else {
      console.log(formatter.list(topResults));
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
