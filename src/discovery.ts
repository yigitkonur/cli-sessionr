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
 * Guarantees sub-50ms performance for direct file reads.
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
      return adapter.parse(filePath);
    }
    throw new SessionReaderError(`Unknown source "${source}".`, {
      code: 'INVALID_SOURCE',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
  }

  // 3. Detect source from file path heuristics
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes('codex') || lowerPath.includes('rollout-')) {
    const adapter = getAdapter('codex');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('claude')) {
    const adapter = getAdapter('claude');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('cursor')) {
    const adapter = getAdapter('cursor-agent');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('gemini')) {
    const adapter = getAdapter('gemini');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('copilot')) {
    const adapter = getAdapter('copilot');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('commandcode')) {
    const adapter = getAdapter('commandcode');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('goose') || lowerPath.endsWith('.sqlite')) {
    const adapter = getAdapter('goose');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('zed') || (lowerPath.endsWith('.db') && lowerPath.includes('thread'))) {
    const adapter = getAdapter('zed');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('kiro')) {
    const adapter = getAdapter('kiro');
    if (adapter) return adapter.parse(filePath);
  }
  if (lowerPath.includes('opencode')) {
    const adapter = getAdapter('opencode');
    if (adapter) return adapter.parse(filePath);
  }

  // Dynamic custom adapters match
  for (const a of getAdapters()) {
    if (lowerPath.includes(a.name.toLowerCase())) {
      return a.parse(filePath);
    }
  }

  // 4. Sniff content for signatures
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    const snippet = buf.toString('utf8', 0, bytesRead);

    if (snippet.includes('"session_meta"') || snippet.includes('apply_patch') || snippet.includes('exec_command') || snippet.includes('"response_item"')) {
      const adapter = getAdapter('codex');
      if (adapter) return adapter.parse(filePath);
    }
    if (snippet.includes('"sessionId"') || snippet.includes('"parentUuid"') || snippet.includes('"uuid"') || snippet.includes('"type":"user"')) {
      const adapter = getAdapter('claude');
      if (adapter) return adapter.parse(filePath);
    }
  } catch {
    // ignore read error and fall through
  }

  // Fallback to claude or codex based on extension
  if (lowerPath.endsWith('.jsonl')) {
    const adapter = getAdapter('claude') ?? getAdapter('codex');
    if (adapter) return adapter.parse(filePath);
  }

  throw new SessionNotFoundError(filePath);
}
