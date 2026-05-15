import './parsers/index.js'; // triggers all parser registrations
import { getAdapters, getAdapter } from './parsers/registry.js';
import { SessionNotFoundError } from './errors.js';
import type { SessionSource, SessionListEntry, NormalizedSession, DiscoveryWarning } from './types.js';

/**
 * Find a session by ID (full or prefix) and parse it.
 * Searches all sources in parallel unless source is specified.
 */
export async function loadSession(
  sessionId: string,
  source?: SessionSource,
  onWarning?: (warning: DiscoveryWarning) => void,
): Promise<NormalizedSession> {
  const entries = await listSessions(source, undefined, onWarning);
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
        source: adapters[i].name,
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
