import * as path from 'path';
import { listSessions, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, SessionListEntry } from '../types.js';

const SOURCES_LIST = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed', 'factory'];

function isPwdRelevant(entryCwd: string, pwd: string): boolean {
  if (!entryCwd) return false;
  if (entryCwd === pwd) return true;
  return pwd.startsWith(entryCwd + path.sep);
}

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function listCommand(
  source?: string,
  opts?: { limit?: string; offset?: string; search?: string; maxSessions?: string; cwd?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat = opts?.output ?? (opts?.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts?.output,
    json: opts?.json,
    isTTY,
  });

  try {
    const limit = parseBoundedInt(opts?.limit, 20, 1, 1000);
    const offset = parseBoundedInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let allEntries = await listSessions(source as SessionSource | undefined);

    // Drop empty sessions (no user/assistant exchange) from the listing
    allEntries = allEntries.filter((e) => !e.isEmpty);

    // Rank entries whose cwd matches (or contains) the current working directory first.
    // Within each bucket, the existing recency order is preserved.
    const pwd = process.cwd();
    const pwdMatches: SessionListEntry[] = [];
    const others: SessionListEntry[] = [];
    for (const e of allEntries) {
      (isPwdRelevant(e.cwd, pwd) ? pwdMatches : others).push(e);
    }
    allEntries = [...pwdMatches, ...others];

    // Optional explicit cwd filter
    if (opts?.cwd && opts.cwd !== 'all' && opts.cwd !== 'auto') {
      const cwd = opts.cwd === 'current' ? process.cwd() : opts.cwd;
      allEntries = allEntries.filter((entry) => entry.cwd === cwd);
    }

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
        api_version: 1,
        sessions: entries,
        total_available: allEntries.length,
        limit,
        offset,
        has_more: hasMore,
        available_sources: SOURCES_LIST,
      };

      if (searchMeta) result.meta = { search: searchMeta };

      result.cursor = {
        next: hasMore
          ? `${prefix} list${source ? ' ' + source : ''} --offset ${offset + limit} --limit ${limit}`
          : null,
        prev: offset > 0
          ? `${prefix} list${source ? ' ' + source : ''} --offset ${Math.max(0, offset - limit)} --limit ${limit}`
          : null,
        first: offset > 0
          ? `${prefix} list${source ? ' ' + source : ''} --offset 0 --limit ${limit}`
          : null,
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
