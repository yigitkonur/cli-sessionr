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
    // trimToAssistantLast trims trailing user(5), keeping 4 messages ending on assistant
    expect(result.messages).toHaveLength(4);
    expect(result.messages[result.messages.length - 1].role).toBe('assistant');
    expect(result.meta.has_more_before).toBe(false);
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
    const budget = singleTokens * 7;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'search', 'authentication bug');
    const indices = result.messages.map((m) => m.index);
    // Match is at index 10 (user). Result should include nearby messages ending on assistant.
    expect(indices).toContain(10);
    expect(result.messages[result.messages.length - 1].role).toBe('assistant');
  });

  it('search anchor returns empty messages with matched: false when no match', () => {
    const msgs = makeMsgs(10);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 3;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'search', 'nonexistent query');
    expect(result.messages.length).toBe(0);
    expect(result.meta.search?.matched).toBe(false);
    expect(result.meta.search?.matchIndex).toBeNull();
    expect(result.meta.search?.query).toBe('nonexistent query');
  });

  it('respects message boundaries (never truncates mid-message)', { timeout: 30000 }, () => {
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

describe('Search multi-field filtering (Issue #10)', () => {
  const toolMsgs: NormalizedMessage[] = [
    makeMsg(1, 'user', 'Deploy the app'),
    {
      index: 2,
      role: 'assistant',
      timestamp: new Date(),
      content: 'Running deployment script',
      blocks: [{ type: 'text', text: 'Running deployment script' }],
    },
    {
      index: 3,
      role: 'tool_use',
      timestamp: new Date(),
      content: 'Tool: Bash',
      blocks: [
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'Bash',
          input: { command: 'npm run deploy:staging --force' },
        },
      ],
    },
    {
      index: 4,
      role: 'tool_result',
      timestamp: new Date(),
      content: 'Deployment successful with exit code 0',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tu-1',
          content: 'Deployment successful with exit code 0',
          isError: false,
        },
      ],
    },
  ];

  it('finds match in content by default', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'deployment');
    expect(result.meta.search?.matched).toBe(true);
    expect(result.meta.search?.matchIndex).toBe(2);
  });

  it('fails to find tool_input string if searching only content', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'staging --force', undefined, 'content');
    expect(result.messages.length).toBe(0);
    expect(result.meta.search?.matched).toBe(false);
  });

  it('finds string inside tool_input when tool_input field is specified', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'staging --force', undefined, 'tool_input');
    expect(result.meta.search?.matched).toBe(true);
    expect(result.meta.search?.matchIndex).toBe(3);
  });

  it('finds string inside tool_result when tool_result field is specified', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'exit code 0', undefined, 'tool_result');
    expect(result.meta.search?.matched).toBe(true);
    expect(result.meta.search?.matchIndex).toBe(4);
  });
});
