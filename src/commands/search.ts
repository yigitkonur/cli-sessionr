import { listSessions, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { EXIT, exitCodeForError, SessionReaderError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type {
  SessionSource,
  OutputFormat,
  SessionListEntry,
  V2Action,
  V2Meta,
} from '../types.js';

interface SearchMatch {
  messageIndex: number;
  snippet: string;
  charOffset: number;
}

interface SearchResult extends SessionListEntry {
  matchCount: number;
  matches: SearchMatch[];
  /** it/08: a single quick-preview snippet so callers don't have to drill into matches[]. */
  snippet?: string;
}

function findSearchMatches(
  messages: { index: number; content: string }[],
  query: string,
  maxMatches = 5,
  snippetRadius = 50,
): SearchMatch[] {
  const lowerQuery = query.toLowerCase();
  const found: SearchMatch[] = [];
  for (const msg of messages) {
    const idx = msg.content.toLowerCase().indexOf(lowerQuery);
    if (idx === -1) continue;
    // it/08: snippet = ~50 chars before + match + ~50 chars after, with
    // whitespace collapsed and ellipses for trimmed edges so it stays one
    // line in tools that don't word-wrap.
    const from = Math.max(0, idx - snippetRadius);
    const to = Math.min(msg.content.length, idx + query.length + snippetRadius);
    const snippet =
      (from > 0 ? '…' : '') +
      msg.content.slice(from, to).replace(/\s+/g, ' ').trim() +
      (to < msg.content.length ? '…' : '');
    found.push({ messageIndex: msg.index, snippet, charOffset: idx });
    if (found.length >= maxMatches) break;
  }
  return found;
}

// MEDIUM-6 (adversarial review): was a silent clamp (Math.min/Math.max) that
// turned `--top 0` into 1 and `--max-sessions nope` into the default with
// ok:true/exit 0. An agent passing a bad value got wrong-sized results and no
// signal. Now strict: out-of-range or non-integer throws INVALID_RANGE (exit 2)
// like the equivalent guard in list.ts.
function parseBoundedIntStrict(flag: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SessionReaderError(`${flag}: must be an integer in [${min}, ${max}]`, {
      code: 'INVALID_RANGE',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { argument: flag, provided: value, min, max },
      suggestion: `sessionr search -q "<query>" ${flag} ${fallback}`,
    });
  }
  return parsed;
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
    timing?: boolean;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    // search-without-query validation: commander already enforces `-q` is
    // present (requiredOption) but accepts empty strings, which would scan
    // every session and return every result. Reject those upfront.
    if (typeof opts.query !== 'string' || opts.query.trim() === '') {
      throw new SessionReaderError('search requires a non-empty --query', {
        code: 'INVALID_QUERY',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        detail: { provided: opts.query ?? null },
        suggestion: `${cmdPrefix()} search -q "deploy failed"`,
      });
    }

    const maxSessions = parseBoundedIntStrict('--max-sessions', opts.maxSessions, 20, 1, 200);
    const top = parseBoundedIntStrict('--top', opts.top, 10, 1, 200);
    const allEntries = await listSessions(opts.source as SessionSource | undefined);
    const entries = allEntries.slice(0, maxSessions);
    const query = opts.query.toLowerCase();
    const results: SearchResult[] = [];

    for (const entry of entries) {
      try {
        const session = await loadSession(entry.id, entry.source);
        const matchingMessages = session.messages.filter((msg) => msg.content.toLowerCase().includes(query));
        const matchCount = matchingMessages.length;
        if (matchCount > 0) {
          const matches = findSearchMatches(session.messages, opts.query);
          results.push({
            ...entry,
            matchCount,
            matches,
            // it/08: hoist the first match as a top-level snippet so callers
            // can preview results without walking matches[].
            snippet: matches[0]?.snippet,
          });
        }
      } catch {
        // skip sessions that fail to parse
      }
    }

    results.sort((a, b) => b.matchCount - a.matchCount);
    const topResults = results.slice(0, top);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const prefix = cmdPrefix();
      const actions: V2Action[] = [];
      if (topResults.length > 0) {
        actions.push({
          command: `${prefix} read ${topResults[0].id} --search "${opts.query}" --tokens 4000`,
          description: 'Read top match with context',
        });
      }
      if (allEntries.length > maxSessions) {
        actions.push({
          command: `${prefix} search -q "${opts.query}" --max-sessions ${maxSessions + 20}`,
          description: 'Search more sessions',
        });
      }

      const result: Record<string, unknown> = {
        query: opts.query,
        sessions_scanned: entries.length,
        results: topResults.map((r) => ({
          id: r.id,
          source: r.source,
          cwd: r.cwd,
          // HIGH-3 (adversarial review): was camelCase `updatedAt` — the only
          // non-snake_case key in the search result block. Match the contract.
          updated_at: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
          summary: r.summary,
          match_count: r.matchCount,
          // it/08: top-level snippet preview (50 chars before + match + 50 chars after).
          snippet: r.snippet,
          matches: r.matches.map((match) => ({
            message_index: match.messageIndex,
            snippet: match.snippet,
            char_offset: match.charOffset,
          })),
        })),
        total_matches: topResults.length,
      };

      const meta: V2Meta = {
        sessions_available: allEntries.length,
        top,
        max_sessions: maxSessions,
      };

      emit(success(result, { meta, actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(formatter.list(topResults) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'SEARCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(formatter.error(error) + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}
