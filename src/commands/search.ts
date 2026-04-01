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
    json?: boolean;
    output?: OutputFormat;
  },
): Promise<void> {
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY: process.stdout.isTTY ?? false,
  });

  try {
    const entries = await listSessions(opts.source as SessionSource | undefined);
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

    // Output as list entries — matchCount is included in JSON
    console.log(formatter.list(topResults));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}
