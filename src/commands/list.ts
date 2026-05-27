import { listSessionsScoped, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { exitCodeForError, SessionReaderError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, SessionListEntry, V2Meta } from '../types.js';

const SOURCES_LIST = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed', 'factory'];

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * List sessions, auto-scoped to the current working directory by default.
 *
 * The `--cwd <mode>` flag accepts `auto` (default), `current`, `all`, or an
 * explicit path. The chosen scope is surfaced in the v2 envelope's
 * `meta.cwd_scope` so callers can reason about why a session list looks
 * shorter than they expected (e.g. fellback_to_global when no sessions
 * matched the current directory).
 */
export async function listCommand(
  source?: string,
  opts?: {
    limit?: string;
    offset?: string;
    search?: string;
    maxSessions?: string;
    cwd?: string;
    json?: boolean;
    output?: OutputFormat;
    timing?: boolean;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts?.output ?? (opts?.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts?.output,
    json: opts?.json,
    isTTY,
  });

  try {
    const limit = parseBoundedInt(opts?.limit, 20, 1, 1000);
    const offset = parseBoundedInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Resolve cwd scope mode. Accept `auto|current|all|<path>` and forward
    // unchanged to listSessionsScoped() — discovery.ts owns the semantics.
    const cwdMode = opts?.cwd ?? 'auto';
    const scoped = await listSessionsScoped(source as SessionSource | undefined, cwdMode);
    let allEntries: SessionListEntry[] = scoped.sessions;
    const scopeMeta = scoped.meta;

    // Drop empty sessions (no user/assistant exchange) from the listing
    allEntries = allEntries.filter((e) => !e.isEmpty);

    // Content search across sessions
    let searchMeta: Record<string, unknown> | undefined;
    if (opts?.search) {
      const query = opts.search.toLowerCase();
      const maxSessions = parseBoundedInt(opts.maxSessions, 50, 1, 200);
      const searchableEntries = allEntries.slice(0, maxSessions);
      const matched: typeof allEntries = [];
      for (const entry of searchableEntries) {
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
      searchMeta = {
        query: opts.search,
        sessions_scanned: searchableEntries.length,
        sessions_available: allEntries.length,
        truncated: allEntries.length > searchableEntries.length,
      };
      allEntries = matched;
    }

    const entries = allEntries.slice(offset, offset + limit);
    const hasMore = offset + limit < allEntries.length;
    const prefix = cmdPrefix();

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const result: Record<string, unknown> = {
        sessions: entries.map(serializeEntry),
        total_available: allEntries.length,
        limit,
        offset,
        has_more: hasMore,
        available_sources: SOURCES_LIST,
        cursor: {
          next: hasMore
            ? `${prefix} list${source ? ' ' + source : ''} --offset ${offset + limit} --limit ${limit}`
            : null,
          prev: offset > 0
            ? `${prefix} list${source ? ' ' + source : ''} --offset ${Math.max(0, offset - limit)} --limit ${limit}`
            : null,
          first: offset > 0
            ? `${prefix} list${source ? ' ' + source : ''} --offset 0 --limit ${limit}`
            : null,
        },
      };

      const meta: V2Meta = {
        cwd_scope: scopeMeta.cwd_scope,
        cwd: scopeMeta.cwd,
        ...(scopeMeta.reason ? { cwd_scope_reason: scopeMeta.reason } : {}),
        ...(searchMeta ? { search: searchMeta } : {}),
      };

      const actions: Array<{ command: string; description: string }> = [];
      if (entries.length > 0) {
        actions.push(
          { command: `${prefix} read ${entries[0].id}`, description: 'Read most recent session' },
          { command: `${prefix} stats ${entries[0].id}`, description: 'Full statistics (tools, tokens, files)' },
        );
      }
      actions.push(
        { command: `${prefix} list --search "keyword"`, description: 'Search recent sessions by content' },
        { command: `${prefix} search -q "keyword" --max-sessions 200`, description: 'Search deeper with ranked snippets' },
        { command: `${prefix} send --new -s claude -f prompt.md`, description: 'Start new session' },
      );

      emit(success(result, { meta, actions }), {
        format: outputFormat,
        timing: opts?.timing,
      });
    } else {
      process.stdout.write(formatter.list(entries) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'LIST_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts?.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(formatter.error(error) + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}

function serializeEntry(entry: SessionListEntry): Record<string, unknown> {
  return {
    ...entry,
    updatedAt: entry.updatedAt instanceof Date ? entry.updatedAt.toISOString() : entry.updatedAt,
  };
}
