import fs from 'node:fs';
import './parsers/index.js';
import { loadSession, loadSessionByPath } from './discovery.js';
import {
  sliceByTokenBudget,
  filterByRole,
} from './slicer.js';
import { estimateSessionTokens } from './tokens.js';
import { getPreset, getDefaultTokenBudget } from './config.js';
import { InvalidRangeError, SessionReaderError, EXIT } from './errors.js';
import { segmentTurns, getTurn, findTurnPendingToolCalls } from './turns.js';
import { computeETag } from './etag.js';
import { toExternal } from './output/serialize.js';
import type {
  NormalizedSession,
  ReadOptions,
  ReadEnvelope,
  SliceMeta,
  SessionSource,
  SessionSummary,
  Turn,
  SessionRef,
} from './types.js';

function buildSessionSummary(
  session: NormalizedSession,
  tokenBudget: number | undefined,
): SessionSummary {
  const totalTokens = estimateSessionTokens(session.messages);
  const budget = tokenBudget ?? 4000;
  const pagesEst = Math.ceil(totalTokens / Math.max(1, budget));
  const durationMs = session.stats.durationMs;
  let duration: string | undefined;
  if (durationMs != null) {
    const s = Math.floor(durationMs / 1000);
    if (s < 60) duration = `${s}s`;
    else if (s < 3600) duration = `${Math.floor(s / 60)}m ${s % 60}s`;
    else duration = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  return {
    id: session.id,
    source: session.source,
    model: session.metadata.model,
    cwd: session.metadata.cwd,
    git_branch: session.metadata.gitBranch,
    total_messages: session.stats.totalMessages,
    total_tokens_estimate: totalTokens,
    pages_estimate: pagesEst,
    duration,
    by_role: {
      user: session.stats.byRole.user,
      assistant: session.stats.byRole.assistant,
      system: session.stats.byRole.system,
      tool_use: session.stats.byRole.toolUse,
      tool_result: session.stats.byRole.toolResult,
    },
    context_window: session.metadata.contextWindow,
    context_tokens: session.stats.tokenUsage?.contextTokens,
    reasoning_effort: session.metadata.reasoningEffort,
    rate_limits: toExternal(session.metadata.rateLimits) as SessionSummary['rate_limits'],
  };
}

/**
 * Headless in-memory session reader API.
 * Accepts either a session ID (with discovery lookup), a direct file path,
 * or a { id } / { path, source } reference object.
 */
export async function read(ref: SessionRef, opts?: ReadOptions): Promise<ReadEnvelope> {
  if (opts?.page != null) {
    throw new SessionReaderError('read() does not support page-based reads; page with cursors instead.', {
      code: 'UNSUPPORTED_OPTION', errorClass: 'validation', exitCode: EXIT.USAGE,
      detail: { option: 'page' },
      suggestion: 'Use meta.cursor_after / meta.cursor_before (after / before), or from / to.',
    });
  }

  let session: NormalizedSession;

  if (typeof ref === 'object' && ref !== null) {
    if ('path' in ref && ref.path) {
      session = await loadSessionByPath(ref.path, ref.source ?? opts?.source);
    } else if ('id' in ref && ref.id) {
      session = await loadSession(ref.id, (ref.source ?? opts?.source) as SessionSource | undefined);
    } else {
      throw new SessionReaderError('Invalid session reference: must provide id or path', {
        code: 'INVALID_REF',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
      });
    }
  } else if (typeof ref === 'string') {
    if (
      fs.existsSync(ref) ||
      ref.endsWith('.jsonl') ||
      ref.endsWith('.json') ||
      ref.endsWith('.db') ||
      ref.endsWith('.sqlite') ||
      ref.includes('/') ||
      ref.includes('\\')
    ) {
      session = await loadSessionByPath(ref, opts?.source);
    } else {
      session = await loadSession(ref, opts?.source as SessionSource | undefined);
    }
  } else {
    throw new SessionReaderError('Invalid session reference', {
      code: 'INVALID_REF',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
  }

  let messages = session.messages;
  if (opts?.role) {
    const roles = opts.role.split(',').map((r) => r.trim()).filter(Boolean);
    messages = filterByRole(messages, roles);
  }

  const totalMessages = session.messages.length;
  const tokenBudget = opts?.tokens ?? getDefaultTokenBudget();
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new SessionReaderError('Token budget must be finite and greater than zero.', {
      code: 'INVALID_TOKEN_BUDGET', errorClass: 'validation', exitCode: EXIT.USAGE,
      detail: { provided: tokenBudget },
    });
  }
  const preset = opts?.preset ? getPreset(opts.preset) : undefined;
  const pendingToolCalls = findTurnPendingToolCalls(session.messages);

  let from: number;
  let to: number;
  let selectedTurn: Turn | undefined;
  const isCursorQuery = opts?.after != null || opts?.before != null;

  if (opts?.turn != null) {
    const turns = session.turns ?? segmentTurns(session);
    selectedTurn = getTurn(turns, opts.turn);
    from = selectedTurn.startIndex;
    to = selectedTurn.endIndex;
    // Cursors are strictly exclusive and clamp the turn window inward, as in the CLI.
    if (opts.after != null) from = Math.max(from, opts.after + 1);
    if (opts.before != null) to = Math.min(to, opts.before - 1);
  } else if (opts?.before != null) {
    // Strictly exclusive before (< opts.before)
    from = 1;
    to = opts.before - 1;
  } else if (opts?.after != null) {
    // Strictly exclusive after (> opts.after)
    from = opts.after + 1;
    to = totalMessages;
  } else if (opts?.from != null || opts?.to != null) {
    from = opts?.from ?? 1;
    to = opts?.to ?? totalMessages;
  } else {
    from = 1;
    to = totalMessages;
  }

  const summary = buildSessionSummary(session, tokenBudget);

  // An empty session, or a cursor query past either end, is a terminal empty response (as in the CLI):
  // no messages, no continuation flags and no cursors.
  if (totalMessages === 0 || (isCursorQuery && (from > totalMessages || to < 1 || from > to))) {
    const emptyAnchor = (opts?.anchor as 'head' | 'tail' | 'search' | undefined) ?? 'head';
    const emptyEtag = computeETag(session, {
      preset: preset?.name,
      tokenBudget,
      anchor: emptyAnchor,
      search: opts?.search,
      role: opts?.role,
      from: 0,
      to: 0,
    });
    const emptyMeta: SliceMeta = {
      session_id: session.id,
      source: session.source,
      total_messages: totalMessages,
      total_tokens_estimate: estimateSessionTokens(messages),
      returned_tokens_estimate: 0,
      token_budget: tokenBudget,
      anchor: emptyAnchor,
      range: { from: 0, to: 0 },
      has_more_before: false,
      has_more_after: false,
      cursor_before: null,
      cursor_after: null,
      cursor: { next: null, prev: null, first: null },
      partial: false,
      etag: emptyEtag,
      context_window: session.metadata.contextWindow,
      context_tokens: session.stats.tokenUsage?.contextTokens,
      pending_tool_calls: pendingToolCalls,
      pendingToolCalls: pendingToolCalls,
      ...(selectedTurn ? { turn: selectedTurn, turns: session.turns ?? segmentTurns(session) } : {}),
    };
    const emptyUnchanged = opts?.ifChanged !== undefined && opts.ifChanged === emptyEtag;
    return {
      ok: true,
      sessionId: session.id,
      session_id: session.id,
      source: session.source,
      meta: emptyUnchanged ? ({ ...emptyMeta, unchanged: true } as any) : emptyMeta,
      messages: [],
      summary,
    };
  }

  if (from < 1 || to > totalMessages || from > to) {
    throw new InvalidRangeError(from, to, totalMessages);
  }

  const candidateMessages = messages.filter((m) => m.index >= from && m.index <= to);

  const anchor = opts?.search
    ? ('search' as const)
    : opts?.anchor
      ? (opts.anchor as 'head' | 'tail' | 'search')
      : opts?.before != null
        ? 'tail'
        : opts?.after != null
          ? 'head'
          : 'head';

  const sliceResult = sliceByTokenBudget(
    candidateMessages,
    tokenBudget,
    session.id,
    session.source,
    anchor,
    opts?.search,
    // read() returns normalized messages unrendered, so the budget is measured on what is returned (no preset).
    undefined,
    opts?.searchIn,
    totalMessages,
    {
      preserveTrailing: selectedTurn !== undefined,
      window: selectedTurn ? { from: selectedTurn.startIndex, to: selectedTurn.endIndex } : undefined,
    },
  );

  const etag = computeETag(session, {
    preset: preset?.name,
    tokenBudget,
    anchor,
    search: opts?.search,
    role: opts?.role,
    from: sliceResult.meta.range.from,
    to: sliceResult.meta.range.to,
  });

  const meta: SliceMeta = {
    ...sliceResult.meta,
    etag,
    context_window: session.metadata.contextWindow,
    context_tokens: session.stats.tokenUsage?.contextTokens,
    pending_tool_calls: pendingToolCalls,
    pendingToolCalls: pendingToolCalls,
    ...(selectedTurn ? { turn: selectedTurn, turns: session.turns ?? segmentTurns(session) } : {}),
  };

  // ETag conditional check (--if-changed)
  if (opts?.ifChanged && opts.ifChanged === etag) {
    return {
      ok: true,
      sessionId: session.id,
      session_id: session.id,
      source: session.source,
      meta: {
        ...meta,
        unchanged: true,
      } as any,
      messages: [],
      summary,
    };
  }

  return {
    ok: true,
    sessionId: session.id,
    session_id: session.id,
    source: session.source,
    meta,
    messages: sliceResult.messages,
    summary,
  };
}

/**
 * Programmatic helper to load a session and retrieve its statistics.
 */
export async function getStats(
  ref: SessionRef,
  opts?: { source?: string },
): Promise<NormalizedSession['stats']> {
  let session: NormalizedSession;
  if (typeof ref === 'object' && ref !== null) {
    if ('path' in ref && ref.path) {
      session = await loadSessionByPath(ref.path, ref.source ?? opts?.source);
    } else if ('id' in ref && ref.id) {
      session = await loadSession(ref.id, (ref.source ?? opts?.source) as SessionSource | undefined);
    } else {
      throw new SessionReaderError('Invalid session reference', {
        code: 'INVALID_REF',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
      });
    }
  } else if (typeof ref === 'string') {
    if (
      fs.existsSync(ref) ||
      ref.endsWith('.jsonl') ||
      ref.endsWith('.json') ||
      ref.endsWith('.db') ||
      ref.endsWith('.sqlite') ||
      ref.includes('/') ||
      ref.includes('\\')
    ) {
      session = await loadSessionByPath(ref, opts?.source);
    } else {
      session = await loadSession(ref, opts?.source as SessionSource | undefined);
    }
  } else {
    throw new SessionReaderError('Invalid session reference', {
      code: 'INVALID_REF',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
  }
  return session.stats;
}
