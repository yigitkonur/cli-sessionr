import type { NormalizedMessage, SessionSource, SliceMeta } from './types.js';
import { estimateMessageTokens, estimateSessionTokens } from './tokens.js';

export interface SliceResult {
  messages: NormalizedMessage[];
  meta: SliceMeta;
}

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
      meta: {
        session_id: sessionId,
        source,
        total_messages: 0,
        total_tokens_estimate: 0,
        returned_tokens_estimate: 0,
        token_budget: budget,
        anchor,
        range: { from: 0, to: 0 },
        has_more_before: false,
        has_more_after: false,
        cursor_before: null,
        cursor_after: null,
      },
    };
  }

  let centerIdx: number;

  if (anchor === 'search' && searchQuery) {
    const query = searchQuery.toLowerCase();
    centerIdx = allMessages.findIndex(
      (m) => m.content.toLowerCase().includes(query),
    );
    if (centerIdx === -1) centerIdx = totalMessages - 1; // fallback to tail
  } else if (anchor === 'head') {
    centerIdx = 0;
  } else {
    centerIdx = totalMessages - 1;
  }

  const selected = selectAroundCenter(allMessages, centerIdx, budget, anchor);

  const returnedTokens = estimateSessionTokens(selected);
  const firstIdx = selected[0].index;
  const lastIdx = selected[selected.length - 1].index;

  return {
    messages: selected,
    meta: {
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
    },
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
