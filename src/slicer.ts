import { cmdPrefix } from "./util/invocation.js";
import type { NormalizedMessage, SessionSource, SliceMeta, CursorCommands, VerbosityPreset, SearchField, SearchMeta, PendingToolCall } from './types.js';
import { estimateMessageTokens, estimateSessionTokens, estimateRenderedMessageTokens, estimateRenderedSessionTokens } from './tokens.js';

export interface SliceResult {
  messages: NormalizedMessage[];
  meta: SliceMeta;
}

// ── Search Field Constants & Helpers (Issue #10) ───────────────────────────

export const VALID_SEARCH_FIELDS: readonly SearchField[] = [
  'content',
  'tool_input',
  'tool_result',
] as const;

export function normalizeSearchFields(
  fields?: string | string[] | Set<SearchField>,
): Set<SearchField> {
  if (!fields) return new Set(['content']);
  if (fields instanceof Set) return fields;

  const rawList = Array.isArray(fields)
    ? fields
    : String(fields).split(',').map((s) => s.trim());

  const result = new Set<SearchField>();
  for (const item of rawList) {
    const normalized = item.trim().toLowerCase().replace(/-/g, '_');
    if (normalized === 'all') {
      result.add('content');
      result.add('tool_input');
      result.add('tool_result');
    } else if (
      normalized === 'content' ||
      normalized === 'tool_input' ||
      normalized === 'tool_result'
    ) {
      result.add(normalized as SearchField);
    }
  }

  return result.size > 0 ? result : new Set(['content']);
}

function inputContainsSearch(value: unknown, queryLower: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(queryLower);
  if (Array.isArray(value)) return value.some((item) => inputContainsSearch(item, queryLower));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) =>
      key.toLowerCase().includes(queryLower) || inputContainsSearch(item, queryLower));
  }
  return value != null && String(value).toLowerCase().includes(queryLower);
}

export function messageMatchesSearch(
  msg: NormalizedMessage,
  queryLower: string,
  fields: Set<SearchField>,
): boolean {
  if (!queryLower) return true;

  if (fields.has('content')) {
    if (typeof msg.content === 'string' && msg.content.toLowerCase().includes(queryLower)) {
      return true;
    }
    if (Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.toLowerCase().includes(queryLower)) {
          return true;
        }
      }
    }
  }

  if (fields.has('tool_input')) {
    if (Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if (b.type === 'tool_use') {
          const input = b.input ?? (b as any).args;
          if (input != null) {
            if (inputContainsSearch(input, queryLower)) {
              return true;
            }
          }
        }
      }
    }
  }

  if (fields.has('tool_result')) {
    if (msg.role === 'tool_result' && typeof msg.content === 'string' && msg.content.toLowerCase().includes(queryLower)) {
      return true;
    }
    if (Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if (b.type === 'tool_result') {
          if (typeof b.content === 'string' && b.content.toLowerCase().includes(queryLower)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

// ── Cursor Command Builders ────────────────────────────────────────────────

export function buildCursorCommands(
  sessionId: string,
  meta: { range: { from: number; to: number }; has_more_before: boolean; has_more_after: boolean; token_budget: number | null; total_messages: number },
): CursorCommands {
  const budget = meta.token_budget ?? 4000;

  return {
    prev: meta.has_more_before
      ? {
          command: `sessionr read ${sessionId} --before ${meta.range.from} --tokens ${budget}`,
          offset: meta.range.from,
          limit: budget,
        }
      : null,
    next: meta.has_more_after
      ? {
          command: `sessionr read ${sessionId} --after ${meta.range.to} --tokens ${budget}`,
          offset: meta.range.to,
          limit: budget,
        }
      : null,
    first: meta.range.from > 1
      ? {
          command: `sessionr read ${sessionId} --page 1 --tokens ${budget}`,
          offset: 0,
          limit: budget,
        }
      : null,
  };
}

export function estimatePageCount(messages: NormalizedMessage[], budget: number): number {
  if (messages.length === 0) return 0;
  const totalTokens = estimateSessionTokens(messages);
  return Math.max(1, Math.ceil(totalTokens / budget));
}

// ── Pending Tool Calls Tracking (Issue #6) ─────────────────────────────────

export function getUnresolvedToolCallIds(messages: NormalizedMessage[]): Set<string> {
  const unresolved = new Set<string>();
  for (const msg of messages) {
    if (msg.blocks && Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if (b.type === 'tool_use') {
          unresolved.add(b.id || `tool-${msg.index}`);
        } else if (b.type === 'tool_result') {
          const callId = b.toolUseId ?? (b as any).tool_use_id ?? (b as any).id;
          if (callId) {
            unresolved.delete(callId);
          }
        }
      }
    }
    if (msg.role === 'tool_result') {
      const callId = (msg as any).toolUseId ?? (msg as any).tool_use_id;
      if (callId) {
        unresolved.delete(callId);
      }
    }
  }
  return unresolved;
}

export function computePendingToolCalls(messages: NormalizedMessage[]): PendingToolCall[] {
  const pendingMap = new Map<string, PendingToolCall>();
  const lastUserIndex = messages.reduce((last, msg) => msg.role === 'user' ? Math.max(last, msg.index) : last, 0);
  for (const msg of messages) {
    if (msg.blocks && Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if (b.type === 'tool_use') {
          const callId = b.id || `tool-${msg.index}`;
          pendingMap.set(callId, {
            id: callId,
            tool_use_id: callId,
            name: b.name,
            input: b.input ?? {},
            messageIndex: msg.index,
            index: msg.index,
            superseded: msg.index < lastUserIndex,
            timestamp: typeof msg.timestamp === 'string'
              ? msg.timestamp
              : msg.timestamp instanceof Date && !isNaN(msg.timestamp.getTime())
                ? msg.timestamp.toISOString()
                : undefined,
          });
        } else if (b.type === 'tool_result') {
          const callId = b.toolUseId ?? (b as any).tool_use_id ?? (b as any).id;
          if (callId) {
            pendingMap.delete(callId);
          }
        }
      }
    } else if (msg.role === 'tool_use') {
      const callId = (msg as any).toolUseId ?? (msg as any).id ?? `tool-${msg.index}`;
      pendingMap.set(callId, {
        id: callId,
        tool_use_id: callId,
        name: msg.content.replace(/^Tool:\s*/, ''),
        input: {},
        messageIndex: msg.index,
        index: msg.index,
        superseded: msg.index < lastUserIndex,
        timestamp: typeof msg.timestamp === 'string'
          ? msg.timestamp
          : msg.timestamp instanceof Date && !isNaN(msg.timestamp.getTime())
            ? msg.timestamp.toISOString()
            : undefined,
      });
    } else if (msg.role === 'tool_result') {
      const callId = (msg as any).toolUseId ?? (msg as any).tool_use_id;
      if (callId) {
        pendingMap.delete(callId);
      }
    }
  }
  return Array.from(pendingMap.values());
}

function isUnresolvedToolMessage(msg: NormalizedMessage, unresolved: Set<string>): boolean {
  if (msg.role === 'tool_use') {
    if (msg.blocks && msg.blocks.length > 0) {
      return msg.blocks.some((b) => b.type === 'tool_use' && unresolved.has(b.id || `tool-${msg.index}`));
    }
    return unresolved.size > 0;
  }
  if (msg.role === 'assistant' && msg.blocks) {
    return msg.blocks.some((b) => b.type === 'tool_use' && unresolved.has(b.id || `tool-${msg.index}`));
  }
  return false;
}

function trimToAssistantLast(
  messages: NormalizedMessage[],
  unresolvedToolCallIds?: Set<string>,
): NormalizedMessage[] {
  if (messages.length === 0) return messages;

  const last = messages[messages.length - 1];
  if (last.role === 'assistant') return messages;

  const unresolved = unresolvedToolCallIds ?? getUnresolvedToolCallIds(messages);
  if (isUnresolvedToolMessage(last, unresolved)) {
    return messages;
  }

  let end = messages.length - 1;
  while (end >= 0 && messages[end].role !== 'assistant') {
    end--;
  }
  if (messages.slice(end + 1).some((msg) => isUnresolvedToolMessage(msg, unresolved))) {
    return messages;
  }
  if (end >= 0 && end + 1 >= messages.length / 2) {
    return messages.slice(0, end + 1);
  }
  return messages;
}

// ── Page-Based Slicing ─────────────────────────────────────────────────────

export function sliceByPage(
  allMessages: NormalizedMessage[],
  page: number,
  budget: number,
  sessionId: string,
  source: SessionSource,
  preset?: VerbosityPreset,
): SliceResult {
  const totalMessages = allMessages.length;
  const totalTokens = estimateSessionTokens(allMessages);

  if (totalMessages === 0) {
    return {
      messages: [],
      meta: emptySticeMeta(sessionId, source, budget, 'page'),
    };
  }

  const pages: Array<{ from: number; to: number }> = [];
  let i = 0;
  let pageTokens = 0;
  let pageStart = 0;

  while (i < allMessages.length) {
    const msgTokens = preset
      ? estimateRenderedMessageTokens(allMessages[i], preset)
      : estimateMessageTokens(allMessages[i]);
    if (pageTokens + msgTokens > budget && pageTokens > 0) {
      pages.push({ from: pageStart, to: i - 1 });
      pageStart = i;
      pageTokens = 0;
    }
    pageTokens += msgTokens;
    i++;
  }
  if (pageStart < allMessages.length) {
    pages.push({ from: pageStart, to: allMessages.length - 1 });
  }

  const totalPages = pages.length;
  const pageIdx = Math.max(0, Math.min(page - 1, totalPages - 1));
  const pageRange = pages[pageIdx];
  let selected = allMessages.slice(pageRange.from, pageRange.to + 1);
  const unresolvedPageIds = getUnresolvedToolCallIds(allMessages);
  selected = trimToAssistantLast(selected, unresolvedPageIds);
  const returnedTokens = preset
    ? estimateRenderedSessionTokens(selected, preset)
    : estimateSessionTokens(selected);

  const firstIdx = selected[0].index;
  const lastIdx = selected[selected.length - 1].index;

  const meta: SliceMeta = {
    session_id: sessionId,
    source,
    total_messages: totalMessages,
    total_tokens_estimate: totalTokens,
    returned_tokens_estimate: returnedTokens,
    token_budget: budget,
    anchor: 'page',
    range: { from: firstIdx, to: lastIdx },
    has_more_before: pageIdx > 0,
    has_more_after: pageIdx < totalPages - 1,
    cursor_before: pageIdx > 0 ? firstIdx : null,
    cursor_after: pageIdx < totalPages - 1 ? lastIdx : null,
    cursor: { prev: null, next: null, first: null },
    page: { current: pageIdx + 1, total: totalPages },
  };

  meta.cursor = buildCursorCommands(sessionId, meta);

  return { messages: selected, meta };
}

// ── Token-Budget Slicing ───────────────────────────────────────────────────

export function sliceByTokenBudget(
  allMessages: NormalizedMessage[],
  budget: number,
  arg3?: string | SessionSource,
  arg4?: SessionSource | string,
  arg5?: 'head' | 'tail' | 'search' | VerbosityPreset,
  arg6?: string | SearchField[] | string[] | Set<SearchField>,
  arg7?: VerbosityPreset,
  arg8?: number | SearchField[] | string | string[] | Set<SearchField>,
  arg9?: number,
  arg10?: { preserveTrailing?: boolean; window?: { from: number; to: number } },
): SliceResult {
  let sessionId = 'default';
  let source: SessionSource = 'claude';
  let anchor: 'head' | 'tail' | 'search' = 'tail';
  let searchQuery: string | undefined;
  let preset: VerbosityPreset | undefined;
  let searchIn: SearchField[] | string | string[] | Set<SearchField> | undefined;
  let totalSessionMessages: number | undefined;

  if (arg3 === 'head' || arg3 === 'tail' || arg3 === 'search') {
    anchor = arg3 as 'head' | 'tail' | 'search';
    searchQuery = typeof arg4 === 'string' ? arg4 : undefined;
    if (typeof arg5 === 'object') preset = arg5;
    else if (arg5 === 'head' || arg5 === 'tail' || arg5 === 'search') anchor = arg5;
    if (typeof arg6 === 'number') totalSessionMessages = arg6;
    else if (arg6) searchIn = arg6 as any;
    if (typeof arg7 === 'number') totalSessionMessages = arg7;
  } else {
    sessionId = (arg3 as string) ?? 'default';
    source = (arg4 as SessionSource) ?? 'claude';
    anchor = (arg5 as ('head' | 'tail' | 'search')) ?? 'tail';
    searchQuery = typeof arg6 === 'string' ? arg6 : undefined;
    preset = arg7;
    if (typeof arg8 === 'number') totalSessionMessages = arg8;
    else if (arg8 != null) searchIn = arg8 as any;
    if (typeof arg9 === 'number') totalSessionMessages = arg9;
  }

  const totalTokens = estimateSessionTokens(allMessages);
  const totalMessages = totalSessionMessages ?? allMessages.length;
  // Turn-scoped reads (--turn) keep the turn's final message and page against the turn's own window (passed in,
  // because a cursor may already have clamped allMessages); every other read pages against the whole session.
  const preserveTrailing = arg10?.preserveTrailing === true;
  const turnWindow = arg10?.window;

  if (allMessages.length === 0 && !(anchor === 'search' && searchQuery !== undefined)) {
    return {
      messages: [],
      meta: emptySliceMeta(sessionId, source, budget, anchor, totalMessages),
    };
  }

  const searchFields = normalizeSearchFields(searchIn);
  let centerIdx: number;

  if (anchor === 'search' && searchQuery !== undefined) {
    const queryLower = searchQuery.toLowerCase();
    centerIdx = allMessages.findIndex((m) =>
      messageMatchesSearch(m, queryLower, searchFields),
    );

    if (centerIdx === -1) {
      // Issue #10: Non-matching search query returns empty slice with matched: false
      const nonMatchMeta: SliceMeta = {
        session_id: sessionId,
        source,
        total_messages: totalMessages,
        total_tokens_estimate: totalTokens,
        returned_tokens_estimate: 0,
        token_budget: budget,
        anchor: 'search',
        range: { from: 0, to: 0 },
        has_more_before: false,
        has_more_after: false,
        cursor_before: null,
        cursor_after: null,
        cursor: { prev: null, next: null, first: null },
        partial: false,
        search: {
          query: searchQuery,
          matched: false,
          match_index: null,
          fields: Array.from(searchFields),
        },
      };
      return { messages: [], meta: nonMatchMeta };
    }
  } else if (anchor === 'head') {
    centerIdx = 0;
  } else {
    centerIdx = allMessages.length - 1;
  }

  const selected = selectAroundCenter(allMessages, centerIdx, budget, anchor, preset);
  // Only head windows trim a trailing non-assistant message: tail walks keep a trailing prompt (#24), search
  // windows are centered on the match (#23) and turn-scoped reads keep the turn's final message (#25).
  // Unresolved tool calls are never trimmed.
  const trimmed = anchor === 'head' && !preserveTrailing
    ? trimToAssistantLast(selected, getUnresolvedToolCallIds(allMessages))
    : selected;

  const returnedTokens = preset
    ? estimateRenderedSessionTokens(trimmed, preset)
    : estimateSessionTokens(trimmed);
  const firstIdx = trimmed[0].index;
  const lastIdx = trimmed[trimmed.length - 1].index;
  // `partial` (exit 10) means the token budget cut the slice we were handed. Measure it against that
  // slice, not the whole session, so an explicit range like `read <id> 1 2` is not reported as
  // truncated. has_more_* and the cursors page against the session (or the turn window in --turn mode).
  const sliceFirstIdx = allMessages[0].index;
  const sliceLastIdx = allMessages[allMessages.length - 1].index;
  const boundsFirstIdx = turnWindow ? turnWindow.from : 1;
  const boundsLastIdx = turnWindow ? turnWindow.to : totalMessages;

  const meta: SliceMeta = {
    session_id: sessionId,
    source,
    total_messages: totalMessages,
    total_tokens_estimate: totalTokens,
    returned_tokens_estimate: returnedTokens,
    token_budget: budget,
    anchor,
    range: { from: firstIdx, to: lastIdx },
    has_more_before: firstIdx > boundsFirstIdx,
    has_more_after: lastIdx < boundsLastIdx,
    cursor_before: firstIdx > boundsFirstIdx ? firstIdx : null,
    cursor_after: lastIdx < boundsLastIdx ? lastIdx : null,
    cursor: { prev: null, next: null, first: null },
    partial: firstIdx > sliceFirstIdx || lastIdx < sliceLastIdx,
  };

  if (anchor === 'search' && searchQuery !== undefined) {
    const matchedMessage = allMessages[centerIdx];
    meta.search = {
      query: searchQuery,
      matched: true,
      match_index: matchedMessage.index,
      fields: Array.from(searchFields),
    };
  }

  meta.cursor = buildCursorCommands(sessionId, meta);

  return { messages: trimmed, meta };
}

export function emptySliceMeta(
  sessionId: string,
  source: SessionSource,
  budget: number,
  anchor: string,
  totalMessages = 0,
): SliceMeta {
  return {
    session_id: sessionId,
    source,
    total_messages: totalMessages,
    total_tokens_estimate: 0,
    returned_tokens_estimate: 0,
    token_budget: budget,
    anchor: anchor as SliceMeta['anchor'],
    range: { from: 0, to: 0 },
    has_more_before: false,
    has_more_after: false,
    cursor_before: null,
    cursor_after: null,
    cursor: { prev: null, next: null, first: null },
    partial: false,
  };
}

export const emptySticeMeta = emptySliceMeta;

function selectAroundCenter(
  messages: NormalizedMessage[],
  centerIdx: number,
  budget: number,
  anchor: 'head' | 'tail' | 'search',
  preset?: VerbosityPreset,
): NormalizedMessage[] {
  const costFn = (m: NormalizedMessage) =>
    preset ? estimateRenderedMessageTokens(m, preset) : estimateMessageTokens(m);

  const centerTokens = costFn(messages[centerIdx]);
  if (centerTokens > budget) {
    return [messages[centerIdx]];
  }

  const selected: NormalizedMessage[] = [messages[centerIdx]];
  let used = centerTokens;
  let lo = centerIdx - 1;
  let hi = centerIdx + 1;

  if (anchor === 'tail') {
    while (lo >= 0) {
      const cost = costFn(messages[lo]);
      if (used + cost > budget) break;
      selected.unshift(messages[lo]);
      used += cost;
      lo--;
    }
  } else if (anchor === 'head') {
    while (hi < messages.length) {
      const cost = costFn(messages[hi]);
      if (used + cost > budget) break;
      selected.push(messages[hi]);
      used += cost;
      hi++;
    }
  } else {
    let expandBackward = true;
    while (lo >= 0 || hi < messages.length) {
      if (expandBackward && lo >= 0) {
        const cost = costFn(messages[lo]);
        if (used + cost > budget) break;
        selected.unshift(messages[lo]);
        used += cost;
        lo--;
      } else if (!expandBackward && hi < messages.length) {
        const cost = costFn(messages[hi]);
        if (used + cost > budget) break;
        selected.push(messages[hi]);
        used += cost;
        hi++;
      } else if (lo < 0 && hi < messages.length) {
        const cost = costFn(messages[hi]);
        if (used + cost > budget) break;
        selected.push(messages[hi]);
        used += cost;
        hi++;
      } else if (hi >= messages.length && lo >= 0) {
        const cost = costFn(messages[lo]);
        if (used + cost > budget) break;
        selected.unshift(messages[lo]);
        used += cost;
        lo--;
      } else {
        break;
      }
      expandBackward = !expandBackward;
    }
  }

  return selected;
}

export function filterByRole(
  messages: NormalizedMessage[],
  roles: string[],
): NormalizedMessage[] {
  if (roles.length === 0) return messages;
  const roleSet = new Set(roles);
  return messages.filter((m) => roleSet.has(m.role));
}
