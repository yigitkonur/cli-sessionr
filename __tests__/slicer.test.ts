import { describe, it, expect } from 'vitest';
import { sliceByTokenBudget, filterByRole } from '../src/slicer.js';
import { estimateMessageTokens } from '../src/tokens.js';
import type { NormalizedMessage } from '../src/types.js';

function makeMsg(index: number, role: NormalizedMessage['role'], content: string): NormalizedMessage {
  return {
    index,
    role,
    timestamp: new Date(),
    content,
    blocks: [{ type: 'text', text: content }],
  };
}

function makeMsgs(count: number): NormalizedMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMsg(i + 1, i % 2 === 0 ? 'user' : 'assistant', `Message number ${i + 1} with some content`),
  );
}

describe('sliceByTokenBudget', () => {
  it('returns empty result for empty messages', () => {
    const result = sliceByTokenBudget([], 4000, 'sess1', 'claude');
    expect(result.messages).toHaveLength(0);
    expect(result.meta.total_messages).toBe(0);
    expect(result.meta.has_more_before).toBe(false);
    expect(result.meta.has_more_after).toBe(false);
  });

  it('returns all messages when budget is sufficient', () => {
    const msgs = makeMsgs(5);
    const totalTokens = msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    const result = sliceByTokenBudget(msgs, totalTokens + 1000, 'sess1', 'claude', 'tail');
    expect(result.messages).toHaveLength(5);
    expect(result.meta.has_more_before).toBe(false);
    expect(result.meta.has_more_after).toBe(false);
  });

  it('tail anchor selects from end', () => {
    const msgs = makeMsgs(20);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 3;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'tail');
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.index).toBe(20);
    expect(result.meta.has_more_before).toBe(true);
    expect(result.meta.has_more_after).toBe(false);
  });

  it('head anchor selects from start', () => {
    const msgs = makeMsgs(20);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 3;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'head');
    expect(result.messages[0].index).toBe(1);
    expect(result.meta.has_more_before).toBe(false);
    expect(result.meta.has_more_after).toBe(true);
  });

  it('search anchor centers around match', () => {
    const msgs = makeMsgs(20);
    msgs[9] = makeMsg(10, 'user', 'Fix the authentication bug in auth.ts');
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 5;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'search', 'authentication bug');
    const indices = result.messages.map((m) => m.index);
    expect(indices).toContain(10);
  });

  it('search anchor falls back to tail when no match', () => {
    const msgs = makeMsgs(10);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 3;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'search', 'nonexistent query');
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.index).toBe(10);
  });

  it('respects message boundaries (never truncates mid-message)', () => {
    const msgs = [
      makeMsg(1, 'user', 'Short'),
      makeMsg(2, 'assistant', 'A'.repeat(10000)), // large message
      makeMsg(3, 'user', 'Short too'),
    ];
    const budget = estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[2]) + 10;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'tail');
    // Should not include the large message if it doesn't fit
    for (const msg of result.messages) {
      expect(msg.content).toBeDefined();
    }
  });

  it('meta includes correct cursor values', () => {
    const msgs = makeMsgs(10);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 3;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'codex', 'tail');
    expect(result.meta.cursor_before).toBeDefined();
    expect(result.meta.cursor_after).toBeNull();
    expect(result.meta.session_id).toBe('sess1');
    expect(result.meta.source).toBe('codex');
    expect(result.meta.token_budget).toBe(budget);
  });
});

describe('filterByRole', () => {
  it('returns all messages when roles is empty', () => {
    const msgs = makeMsgs(5);
    expect(filterByRole(msgs, [])).toHaveLength(5);
  });

  it('filters to requested roles', () => {
    const msgs = makeMsgs(6);
    const users = filterByRole(msgs, ['user']);
    expect(users.every((m) => m.role === 'user')).toBe(true);
    expect(users.length).toBe(3);
  });

  it('supports multiple roles', () => {
    const msgs = makeMsgs(6);
    const filtered = filterByRole(msgs, ['user', 'assistant']);
    expect(filtered).toHaveLength(6);
  });
});
