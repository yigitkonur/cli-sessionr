import * as path from 'path';
import { listSessionsScoped, loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, SessionListEntry } from '../types.js';

const SOURCES = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed', 'factory'];

function isPwdRelevant(entryCwd: string, pwd: string): boolean {
  if (!entryCwd) return false;
  if (entryCwd === pwd) return true;
  return pwd.startsWith(entryCwd + path.sep);
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
    const limit = opts?.limit ? parseInt(opts.limit, 10) : 20;
    const offset = opts?.offset ? parseInt(opts.offset, 10) : 0;
    const scoped = await listSessionsScoped(source as SessionSource | undefined, opts?.cwd ?? 'auto');
    let allEntries = scoped.sessions;
    let searchMeta: Record<string, unknown> | undefined;

    // Drop empty sessions (no user/assistant exchange) from the listing
    allEntries = allEntries.filter((e) => !e.isEmpty);

    // Within the scoped bucket, rank entries whose cwd matches (or contains) $PWD first.
    // Redundant when scoped is auto/current/explicit; useful when --cwd all.
    const pwd = process.cwd();
    const pwdMatches: SessionListEntry[] = [];
    const others: SessionListEntry[] = [];
    for (const e of allEntries) {
      (isPwdRelevant(e.cwd, pwd) ? pwdMatches : others).push(e);
    }
    allEntries = [...pwdMatches, ...others];

    // Content search across sessions
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

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const prefix = cmdPrefix();
      const hasMore = offset + limit < allEntries.length;
      const result: Record<string, unknown> = {
        api_version: 1,
        sessions: entries,
        total_available: allEntries.length,
        limit,
        offset,
        has_more: hasMore,
        available_sources: SOURCES,
        meta: scoped.meta,
      };
      if (searchMeta) {
        result.meta = { search: searchMeta };
      }

      // Cursor commands
      const cursor: Record<string, string | null> = {
        next: hasMore
          ? `${prefix} list${source ? ' ' + source : ''} --offset ${offset + limit} --limit ${limit}${opts?.cwd ? ` --cwd ${opts.cwd}` : ''}`
          : null,
        prev: offset > 0
          ? `${prefix} list${source ? ' ' + source : ''} --offset ${Math.max(0, offset - limit)} --limit ${limit}${opts?.cwd ? ` --cwd ${opts.cwd}` : ''}`
          : null,
      };
      result.cursor = cursor;

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

function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;

  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, parsed));
}
