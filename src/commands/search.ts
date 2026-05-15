import { listSessionsScoped, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat, SessionListEntry, DiscoveryWarning } from '../types.js';

interface SearchResult extends SessionListEntry {
  matchCount: number;
  matches: SearchMatch[];
}

export async function searchCommand(
  opts: {
    query: string;
    source?: string;
    top?: string;
    maxSessions?: string;
    cwd?: string;
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
    const warnings: DiscoveryWarning[] = [];
    const allEntries = await listSessions(
      opts.source as SessionSource | undefined,
      undefined,
      (warning) => warnings.push(warning),
    );
    const entries = allEntries.slice(0, maxSessions);
    const query = opts.query.toLowerCase();
    const top = parseBounded('--top', opts.top, 10, 1);
    const results: SearchResult[] = [];

    for (const entry of entries) {
      try {
        const session = await loadSession(entry.id, entry.source);
        const matchingMessages = session.messages.filter((msg) => msg.content.toLowerCase().includes(query));
        const matchCount = matchingMessages.length;
        if (matchCount > 0) {
          results.push({
            ...entry,
            matchCount,
            matches: findSearchMatches(session.messages, opts.query),
          });
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
          { command: `${cmdPrefix()} read ${topResults[0].id} --search "${opts.query}" --tokens 4000`, description: 'Read top match with context' },
        );
      }
      if (allEntries.length > maxSessions) {
        actions.push(
          { command: `sessionr search -q "${opts.query}" --max-sessions ${maxSessions + 20}${opts.cwd ? ` --cwd ${opts.cwd}` : ''}`, description: 'Search more sessions' },
        );
      }

      const result: Record<string, unknown> = {
        api_version: 1,
        query: opts.query,
        sessions_scanned: entries.length,
        sessions_available: allEntries.length,
        meta: scoped.meta,
        results: topResults.map((r) => ({
          id: r.id,
          source: r.source,
          cwd: r.cwd,
          updatedAt: r.updatedAt,
          summary: r.summary,
          match_count: r.matchCount,
          matches: r.matches.map((match) => ({
            message_index: match.messageIndex,
            snippet: match.snippet,
            char_offset: match.charOffset,
          })),
        })),
        total_matches: topResults.length,
        actions,
      };
      if (warnings.length > 0) {
        result.meta = { warnings };
      }
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
