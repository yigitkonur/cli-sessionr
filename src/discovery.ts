import './parsers/index.js'; // triggers all parser registrations
import { getAdapters, getAdapter } from './parsers/registry.js';
import { SessionNotFoundError } from './errors.js';
import type { SessionSource, SessionListEntry, NormalizedSession } from './types.js';

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

  merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  if (limit !== undefined && limit > 0) {
    return merged.slice(0, limit);
  }

  return merged;
}
