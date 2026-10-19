import './parsers/index.js'; // triggers all parser registrations
import path from 'node:path';
import fs from 'node:fs';
import { getAdapters, getAdapter } from './parsers/registry.js';
import { SessionNotFoundError, SessionReaderError, EXIT } from './errors.js';
import type { SessionSource, SessionListEntry, NormalizedSession, DiscoveryWarning } from './types.js';

/**
 * Find a session by ID (full or prefix) and parse it.
 * Searches all sources in parallel unless source is specified.
 */
export async function loadSession(
  sessionId: string,
  source?: SessionSource,
  onWarning?: (warning: DiscoveryWarning) => void,
  cachedEntries?: SessionListEntry[],
): Promise<NormalizedSession> {
  const entries = cachedEntries ?? (await listSessions(source, undefined, onWarning));
  const totalSessions = async () => {
    if (!source) return entries.length;
    return (await listSessions(undefined, 1, onWarning)).length;
  };

  // Try exact match first
  let match = entries.find((e) => e.id === sessionId);

  // Fall back to prefix match (pick most recently updated if multiple)
  if (!match) {
    const prefixMatches = entries
      .filter((e) => e.id.startsWith(sessionId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (prefixMatches.length > 1) {
      throw new SessionNotFoundError(sessionId, {
        totalSessions: await totalSessions(),
        prefixMatches,
      });
    }
    if (prefixMatches.length === 1) {
      match = prefixMatches[0];
    }
  }

  if (!match) {
    throw new SessionNotFoundError(sessionId, { totalSessions: await totalSessions() });
  }

  const adapter = getAdapter(match.source);
  if (!adapter) {
    throw new SessionNotFoundError(sessionId, { totalSessions: await totalSessions() });
  }

  return adapter.parse(match.filePath);
}

/**
 * List sessions from one or all sources, sorted by updatedAt desc.
 * Adapter-level discovery failures are reported through onWarning to preserve
 * the existing array return shape for internal callers.
 */
export async function listSessions(
  source?: SessionSource,
  limit?: number,
  onWarning?: (warning: DiscoveryWarning) => void,
): Promise<SessionListEntry[]> {
  const adapters = getAdapters(source as SessionSource | undefined);
  const results = await Promise.allSettled(adapters.map((a) => a.find()));

  const merged: SessionListEntry[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
    } else {
      onWarning?.({
        source: adapters[i].name as SessionSource,
        error: {
          code: 'ADAPTER_FAILED',
          message: String(result.reason instanceof Error ? result.reason.message : result.reason),
        },
      });
    }
  }

  // Dedup by session ID — keep most recently updated entry
  const seen = new Map<string, SessionListEntry>();
  for (const entry of merged) {
    const existing = seen.get(entry.id);
    if (!existing || entry.updatedAt.getTime() > existing.updatedAt.getTime()) {
      seen.set(entry.id, entry);
    }
  }
  const deduped = [...seen.values()];

  deduped.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  if (limit !== undefined && limit > 0) {
    return deduped.slice(0, limit);
  }

  return deduped;
}

import type { CwdScopeMeta } from './types.js';

export interface ScopedListSessionsResult {
  sessions: SessionListEntry[];
  meta: CwdScopeMeta;
}

export async function listSessionsScoped(
  source?: SessionSource,
  cwdMode = 'auto',
): Promise<ScopedListSessionsResult> {
  const sessions = await listSessions(source);
  const cwd = resolveCwdValue(cwdMode);

  if (cwdMode === 'all') {
    return {
      sessions,
      meta: { cwd_scope: 'all', cwd },
    };
  }

  const matching = sessions.filter((entry) => entry.cwd === cwd);
  if (cwdMode === 'auto') {
    if (matching.length > 0) {
      return {
        sessions: matching,
        meta: { cwd_scope: 'auto', cwd },
      };
    }

    return {
      sessions,
      meta: {
        cwd_scope: 'fellback_to_global',
        cwd,
        reason: 'no sessions matched cwd',
      },
    };
  }

  return {
    sessions: matching,
    meta: { cwd_scope: 'explicit', cwd },
  };
}

function resolveCwdValue(cwdMode: string): string {
  if (cwdMode === 'auto' || cwdMode === 'current' || cwdMode === 'all') {
    return process.cwd();
  }
  return path.resolve(cwdMode);
}

/**
 * Load and parse a session directly by file path, bypassing all directory discovery.
 * Runtime depends on file size and adapter parsing; no discovery scan is performed.
 */
export async function loadSessionByPath(
  filePath: string,
  source?: SessionSource | string,
): Promise<NormalizedSession> {
  // 1. Verify existence
  if (!fs.existsSync(filePath)) {
    throw new SessionNotFoundError(filePath);
  }

  // 2. If source explicitly provided, use that adapter
  if (source) {
    const adapter = getAdapter(source as SessionSource);
    if (adapter) {
      assertInsideStore(filePath, adapter.name);
      return adapter.parse(filePath);
    }
    throw new SessionReaderError(`Unknown source "${source}".`, {
      code: 'INVALID_SOURCE',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
  }

  const canonicalSource = detectCanonicalSource(filePath);
  if (canonicalSource) return parseDetectedSource(filePath, canonicalSource);

  let snippet: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    snippet = buf.toString('utf8', 0, bytesRead);
  } catch {
    throw new SessionReaderError('Could not read the session file.', {
      code: 'SESSION_FILE_READ_FAILED', errorClass: 'internal', exitCode: EXIT.ERROR,
      detail: { file_path: filePath },
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const records: unknown[] = [];
  try { records.push(JSON.parse(snippet)); } catch { /* JSONL or an incomplete JSON document */ }
  for (const line of snippet.split(/\r?\n/).slice(0, 32)) {
    try { records.push(JSON.parse(line)); } catch { /* Skip incomplete or malformed records */ }
  }
  const sources = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const row = record as Record<string, unknown>;
    const payload = row.payload;
    if (typeof row.type === 'string' &&
        ['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(row.type) &&
        payload && typeof payload === 'object' && !Array.isArray(payload)) sources.add('codex');
    if (['user', 'assistant', 'system'].includes(String(row.type)) &&
        row.message && typeof row.message === 'object' && !Array.isArray(row.message) &&
        (typeof row.sessionId === 'string' || typeof row.uuid === 'string')) sources.add('claude');
    if (typeof row.step_index === 'number' && typeof row.type === 'string' &&
        /^[A-Z][A-Z_]+$/.test(row.type)) sources.add('antigravity');
    if (typeof row.sessionId === 'string' && Array.isArray(row.messages)) sources.add('gemini');
  }
  if (sources.size === 1) return parseDetectedSource(filePath, [...sources][0]);
  throw new SessionReaderError(
    sources.size > 1 ? 'The file contains ambiguous session formats.' : 'Unrecognized session file format.',
    {
      code: sources.size > 1 ? 'AMBIGUOUS_SESSION_FORMAT' : 'UNRECOGNIZED_SESSION_FILE',
      errorClass: 'validation', exitCode: EXIT.USAGE,
      detail: { file_path: filePath, sources: [...sources] },
      suggestion: 'Pass an explicit source to loadSessionByPath(path, source).',
    },
  );
}

// Goose and OpenCode resolve a session's messages from their own global stores by id, not from the file that
// was passed in, so a copied or imported file would silently return whatever local session shares its id.
const STORE_BACKED_SOURCES = new Set(['goose', 'opencode']);

function assertInsideStore(filePath: string, sourceName: string): void {
  const name = sourceName.toLowerCase();
  if (!STORE_BACKED_SOURCES.has(name) || detectCanonicalSource(filePath) === name) return;
  throw new SessionReaderError(` sessions can only be read from 's own session store.`, {
    code: 'SOURCE_STORE_PATH_REQUIRED', errorClass: 'validation', exitCode: EXIT.USAGE,
    detail: { file_path: filePath, source: sourceName },
    suggestion: 'Pass a file inside the tool\'s own session store, or read the session by id.',
  });
}

function detectCanonicalSource(filePath: string): string | undefined {
  const normalized = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
  const roots: Array<[RegExp, string]> = [
    [/\/\.claude\/projects\//, 'claude'],
    [/\/\.codex\/(sessions|archived_sessions)\//, 'codex'],
    [/\/\.gemini\/antigravity-cli\/brain\//, 'antigravity'],
    [/\/\.gemini\/tmp\//, 'gemini'],
    [/\/\.copilot\/session-state\//, 'copilot'],
    [/\/\.cursor\/projects\/.*\/agent-transcripts\//, 'cursor-agent'],
    [/\/\.commandcode\/projects\//, 'commandcode'],
    [/\/\.local\/share\/goose\/sessions\//, 'goose'],
    [/\/\.local\/share\/opencode\/storage\//, 'opencode'],
    [/\/\.kiro\/.*\/globalstorage\/kiro\.kiroagent\//, 'kiro'],
    [/\/zed\/threads\/threads\.db$/, 'zed'],
    [/\/\.factory\/sessions\//, 'factory'],
  ];
  return roots.find(([pattern]) => pattern.test(normalized))?.[1];
}

function parseDetectedSource(filePath: string, source: string): Promise<NormalizedSession> {
  const adapter = getAdapters().find((candidate) => candidate.name.toLowerCase() === source.toLowerCase());
  if (adapter) return adapter.parse(filePath);
  throw new SessionReaderError(`No adapter is registered for detected source "${source}".`, {
    code: 'SOURCE_UNAVAILABLE', errorClass: 'validation', exitCode: EXIT.USAGE,
    detail: { file_path: filePath, source },
    suggestion: 'Register the source adapter or pass an explicit source.',
  });
}
