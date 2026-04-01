import type { NormalizedMessage, SessionSource, SliceMeta, CursorCommands } from './types.js';
import { estimateMessageTokens, estimateSessionTokens } from './tokens.js';

export interface SliceResult {
  messages: NormalizedMessage[];
  meta: SliceMeta;
}

// ── Cursor Command Builders ────────────────────────────────────────────────

export function buildCursorCommands(
  sessionId: string,
  meta: { range: { from: number; to: number }; has_more_before: boolean; has_more_after: boolean; token_budget: number | null; total_messages: number },
): CursorCommands {
  const budget = meta.token_budget ?? 4000;
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;

  return {
    prev: meta.has_more_before
      ? `sessionr read ${shortId} --before ${meta.range.from} --tokens ${budget}`
      : null,
    next: meta.has_more_after
      ? `sessionr read ${shortId} --after ${meta.range.to} --tokens ${budget}`
      : null,
    first: meta.range.from > 1
      ? `sessionr read ${shortId} --page 1 --tokens ${budget}`
      : null,
  };
}

export function estimatePageCount(messages: NormalizedMessage[], budget: number): number {
  if (messages.length === 0) return 0;
  const totalTokens = estimateSessionTokens(messages);
  return Math.max(1, Math.ceil(totalTokens / budget));
}

function trimToAssistantLast(messages: NormalizedMessage[]): NormalizedMessage[] {
  if (messages.length === 0) return messages;
  if (messages[messages.length - 1].role === 'assistant') return messages;
  let end = messages.length - 1;
  while (end >= 0 && messages[end].role !== 'assistant') {
    end--;
  }
  // Only trim if we keep at least half the messages; otherwise keep all
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
): SliceResult {
  const totalMessages = allMessages.length;
  const totalTokens = estimateSessionTokens(allMessages);

  if (totalMessages === 0) {
    return {
      messages: [],
      meta: emptySticeMeta(sessionId, source, budget, 'page'),
    };
  }

  // Build pages from head: page 1 starts at message 1
  const pages: Array<{ from: number; to: number }> = [];
  let i = 0;
  let pageTokens = 0;
  let pageStart = 0;

  while (i < allMessages.length) {
    const msgTokens = estimateMessageTokens(allMessages[i]);
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
  selected = trimToAssistantLast(selected);
  const returnedTokens = estimateSessionTokens(selected);

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
    cursor_before: pageIdx > 0 ? firstIdx - 1 : null,
    cursor_after: pageIdx < totalPages - 1 ? lastIdx + 1 : null,
    cursor: { prev: null, next: null, first: null },
    page: { current: pageIdx + 1, total: totalPages },
  };

  meta.cursor = buildCursorCommands(sessionId, meta);

  return { messages: selected, meta };
}

// ── Token-Budget Slicing (existing) ────────────────────────────────────────

export function sliceByTokenBudget(
  allMessages: NormalizedMessage[],
  budget: number,
  sessionId: string,
  source: SessionSource,
  anchor: 'head' | 'tail' | 'search' = 'tail',
  searchQuery?: string,
): SliceResult {
  const totalTokens = estimateSessionTokens(allMessages);
  const totalMessages = allMessages.length;

  if (totalMessages === 0) {
    return {
      messages: [],
      meta: emptySticeMeta(sessionId, source, budget, anchor),
    };
  }

  let centerIdx: number;

  if (anchor === 'search' && searchQuery) {
    const query = searchQuery.toLowerCase();
    centerIdx = allMessages.findIndex(
      (m) => m.content.toLowerCase().includes(query),
    );
    if (centerIdx === -1) centerIdx = totalMessages - 1;
  } else if (anchor === 'head') {
    centerIdx = 0;
  } else {
    centerIdx = totalMessages - 1;
  }

  const selected = selectAroundCenter(allMessages, centerIdx, budget, anchor);
  const trimmed = trimToAssistantLast(selected);

  const returnedTokens = estimateSessionTokens(trimmed);
  const firstIdx = trimmed[0].index;
  const lastIdx = trimmed[trimmed.length - 1].index;

  const meta: SliceMeta = {
    session_id: sessionId,
    source,
    total_messages: totalMessages,
    total_tokens_estimate: totalTokens,
    returned_tokens_estimate: returnedTokens,
    token_budget: budget,
    anchor,
    range: { from: firstIdx, to: lastIdx },
    has_more_before: firstIdx > 1,
    has_more_after: lastIdx < totalMessages,
    cursor_before: firstIdx > 1 ? firstIdx - 1 : null,
    cursor_after: lastIdx < totalMessages ? lastIdx + 1 : null,
    cursor: { prev: null, next: null, first: null },
  };

  meta.cursor = buildCursorCommands(sessionId, meta);

  return { messages: trimmed, meta };
}

function emptySticeMeta(
  sessionId: string,
  source: SessionSource,
  budget: number,
  anchor: string,
): SliceMeta {
  return {
    session_id: sessionId,
    source,
    total_messages: 0,
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
  };
}

function selectAroundCenter(
  messages: NormalizedMessage[],
  centerIdx: number,
  budget: number,
  anchor: 'head' | 'tail' | 'search',
): NormalizedMessage[] {
  const centerTokens = estimateMessageTokens(messages[centerIdx]);
  if (centerTokens > budget) {
    return [messages[centerIdx]];
  }

  const selected: NormalizedMessage[] = [messages[centerIdx]];
  let used = centerTokens;
  let lo = centerIdx - 1;
  let hi = centerIdx + 1;

  if (anchor === 'tail') {
    // Expand backward only
    while (lo >= 0) {
      const cost = estimateMessageTokens(messages[lo]);
      if (used + cost > budget) break;
      selected.unshift(messages[lo]);
      used += cost;
      lo--;
    }
  } else if (anchor === 'head') {
    // Expand forward only
    while (hi < messages.length) {
      const cost = estimateMessageTokens(messages[hi]);
      if (used + cost > budget) break;
      selected.push(messages[hi]);
      used += cost;
      hi++;
    }
  } else {
    // Search: expand outward from center, alternating
    let expandBackward = true;
    while (lo >= 0 || hi < messages.length) {
      if (expandBackward && lo >= 0) {
        const cost = estimateMessageTokens(messages[lo]);
        if (used + cost > budget) break;
        selected.unshift(messages[lo]);
        used += cost;
        lo--;
      } else if (!expandBackward && hi < messages.length) {
        const cost = estimateMessageTokens(messages[hi]);
        if (used + cost > budget) break;
        selected.push(messages[hi]);
        used += cost;
        hi++;
      } else if (lo < 0 && hi < messages.length) {
        const cost = estimateMessageTokens(messages[hi]);
        if (used + cost > budget) break;
        selected.push(messages[hi]);
        used += cost;
        hi++;
      } else if (hi >= messages.length && lo >= 0) {
        const cost = estimateMessageTokens(messages[lo]);
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
