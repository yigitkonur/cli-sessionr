import './parsers/index.js'; // triggers all parser registrations
import path from 'node:path';
import { getAdapters, getAdapter } from './parsers/registry.js';
import { SessionNotFoundError } from './errors.js';
import type { CwdScopeMeta, SessionSource, SessionListEntry, NormalizedSession } from './types.js';

/**
 * Find a session by ID (full or prefix) and parse it.
 * Searches all sources in parallel unless source is specified.
 */
export async function loadSession(
  sessionId: string,
  source?: SessionSource,
): Promise<NormalizedSession> {
  const entries = await listSessions(source);

  // Try exact match first
  let match = entries.find((e) => e.id === sessionId);

  // Fall back to prefix match (pick most recently updated if multiple)
  if (!match) {
    const prefixMatches = entries
      .filter((e) => e.id.startsWith(sessionId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (prefixMatches.length > 0) {
      match = prefixMatches[0];
    }
  }

  if (!match) {
    throw new SessionNotFoundError(sessionId);
  }

  const adapter = getAdapter(match.source);
  if (!adapter) {
    throw new SessionNotFoundError(sessionId);
  }

  return adapter.parse(match.filePath);
}

/**
 * List sessions from one or all sources, sorted by updatedAt desc.
 */
export async function listSessions(
  source?: SessionSource,
  limit?: number,
): Promise<SessionListEntry[]> {
  const adapters = getAdapters(source as SessionSource | undefined);
  const results = await Promise.allSettled(adapters.map((a) => a.find()));

  const merged: SessionListEntry[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
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
