import { listSessionsScoped, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { toExternal } from '../output/serialize.js';
import { EXIT, exitCodeForError, SessionReaderError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, SessionListEntry, V2Meta } from '../types.js';

const SOURCES_LIST = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed', 'factory'];

// dc/06: strict numeric validation for --limit / --offset. Reject anything
// outside [min,max] with INVALID_RANGE so callers see a clean envelope-coded
// error instead of being silently clamped (which silently produced wrong-sized
// pages and broke downstream pagination math).
function parseBoundedIntStrict(
  flag: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') {
    throw new SessionReaderError(`${flag}: must be an integer in [${min}, ${max}]`, {
      code: 'INVALID_RANGE',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { argument: flag, provided: value, min, max },
      suggestion: `sessionr list ${flag} 20`,
    });
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new SessionReaderError(`${flag}: must be an integer in [${min}, ${max}]`, {
      code: 'INVALID_RANGE',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { argument: flag, provided: value, min, max },
      suggestion: `sessionr list ${flag} 20`,
    });
  }
  if (parsed < min || parsed > max) {
    throw new SessionReaderError(`${flag}: ${parsed} out of range [${min}, ${max}]`, {
      code: 'INVALID_RANGE',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { argument: flag, provided: parsed, min, max },
      suggestion: `sessionr list ${flag} 20`,
    });
  }
  return parsed;
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
    const limit = parseBoundedIntStrict('--limit', opts?.limit, 20, 0, 1000);
    const offset = parseBoundedIntStrict('--offset', opts?.offset, 0, 0, 1000);

    // Resolve cwd scope mode. Accept `auto|current|all|<path>` and forward
    // unchanged to listSessionsScoped() — discovery.ts owns the semantics.
    const cwdMode = opts?.cwd ?? 'auto';
    const scoped = await listSessionsScoped(source as SessionSource | undefined, cwdMode);
    let allEntries: SessionListEntry[] = scoped.sessions;
    const scopeMeta = scoped.meta;

    // Drop empty sessions (no user/assistant exchange) from the listing
    allEntries = allEntries.filter((e) => !e.isEmpty);

    // Content search across sessions
    // it/09: surface scanned_sessions + search_truncated on meta so agents
    // never wonder why a list-q only returned N — the response now carries
    // the cap and whether more sessions exist than were searched.
    let searchMeta: Record<string, unknown> | undefined;
    let searchTruncated = false;
    let scannedSessions = 0;
    if (opts?.search) {
      const query = opts.search.toLowerCase();
      const maxSessions = parseBoundedIntStrict('--max-sessions', opts.maxSessions, 50, 1, 200);
      const searchableEntries = allEntries.slice(0, maxSessions);
      scannedSessions = searchableEntries.length;
      searchTruncated = allEntries.length > searchableEntries.length;
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
        sessions_scanned: scannedSessions,
        sessions_available: allEntries.length,
        truncated: searchTruncated,
        max_sessions: maxSessions,
      };
      allEntries = matched;
    }

    const entries = allEntries.slice(offset, offset + limit);
    const hasMore = offset + limit < allEntries.length;
    const prefix = cmdPrefix();

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      // it/05: cursor returns both the runnable command AND the raw numeric
      // tokens (offset / limit) so agents can compute their own pagination
      // without re-parsing the command string.
      const nextOffset = offset + limit;
      const prevOffset = Math.max(0, offset - limit);
      const result: Record<string, unknown> = {
        sessions: entries.map(serializeEntry),
        total_available: allEntries.length,
        limit,
        offset,
        has_more: hasMore,
        available_sources: SOURCES_LIST,
        cursor: {
          next: hasMore
            ? {
                command: `${prefix} list${source ? ' ' + source : ''} --offset ${nextOffset} --limit ${limit}`,
                offset: nextOffset,
                limit,
              }
            : null,
          prev: offset > 0
            ? {
                command: `${prefix} list${source ? ' ' + source : ''} --offset ${prevOffset} --limit ${limit}`,
                offset: prevOffset,
                limit,
              }
            : null,
          first: offset > 0
            ? {
                command: `${prefix} list${source ? ' ' + source : ''} --offset 0 --limit ${limit}`,
                offset: 0,
                limit,
              }
            : null,
        },
      };

      // it/07: emit the most-likely next command(s) inline on meta so agents
      // don't have to scan actions[] to know what to do next. it/09: surface
      // search_truncated + scanned_sessions at the top level (mirrors the
      // nested .search.* fields).
      const nextAction: Record<string, unknown> = {};
      if (entries.length > 0) {
        nextAction.read = `${prefix} read ${entries[0].id} --tokens 4000`;
        nextAction.info = `${prefix} info ${entries[0].id}`;
        nextAction.tip = 'Use info first for cheap metadata, then read with a token budget.';
      } else if (opts?.search) {
        nextAction.tip = 'No matches. Increase --max-sessions or try sessionr search -q "<term>".';
      } else {
        nextAction.tip = 'Try --cwd all to widen the search, or sessionr send --new -s claude.';
      }

      const meta: V2Meta = {
        cwd_scope: scopeMeta.cwd_scope,
        cwd: scopeMeta.cwd,
        ...(scopeMeta.reason ? { cwd_scope_reason: scopeMeta.reason } : {}),
        ...(searchMeta
          ? {
              search: searchMeta,
              search_truncated: searchTruncated,
              scanned_sessions: scannedSessions,
            }
          : {}),
        next_action: nextAction,
      };

      // dc/08: emit several useful tips, not just the lone "read latest"
      // action. Order from highest-leverage to lowest so an agent can
      // walk the list top-down.
      const actions: Array<{ command: string; description: string }> = [];
      if (entries.length > 0) {
        actions.push(
          { command: `${prefix} read ${entries[0].id} --tokens 4000`, description: 'Read most recent session (first page)' },
          { command: `${prefix} info ${entries[0].id}`, description: 'Cheap metadata for the most recent session' },
          { command: `${prefix} stats ${entries[0].id}`, description: 'Full statistics (tools, tokens, files)' },
        );
      }
      actions.push(
        { command: `${prefix} list --search "keyword"`, description: 'Search recent sessions by content (top 50)' },
        { command: `${prefix} search -q "keyword" --max-sessions 200`, description: 'Search deeper with ranked snippets' },
        { command: `${prefix} prune --older-than 30d --dry-run`, description: 'Preview cleanup of old sessions' },
        { command: `${prefix} doctor`, description: 'Diagnose source / CLI binary setup' },
        { command: `${prefix} send --new -s claude -f prompt.md`, description: 'Start a new session' },
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
  // HIGH-3 (adversarial review): the old `...entry` spread leaked camelCase
  // keys (updatedAt, filePath, isEmpty) into the v2 envelope on the highest-
  // traffic read path. toExternal() snake_cases them (updated_at, file_path,
  // is_empty) and ISO-encodes the Date in one pass.
  return toExternal(entry) as Record<string, unknown>;
}
