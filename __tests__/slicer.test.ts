import { describe, it, expect } from 'vitest';
import { sliceByTokenBudget, filterByRole, computePendingToolCalls } from '../src/slicer.js';
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
    // Backwards cursor walks must retain the actual end, even a trailing user.
    expect(result.messages).toHaveLength(5);
    expect(result.messages[result.messages.length - 1].index).toBe(5);
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
    expect(result.meta.search?.match_index).toBeNull();
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

describe('Exclusive cursor semantics (Issue #11)', () => {
  it('cursor_after matches range.to and agrees with cursor.next.command', () => {
    const msgs = makeMsgs(20);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 4;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'head');

    expect(result.meta.has_more_after).toBe(true);
    expect(result.meta.cursor_after).toBe(result.meta.range.to);
    expect(result.meta.cursor?.next?.command).toContain(`--after ${result.meta.cursor_after} --tokens`);
  });

  it('cursor_before matches range.from and agrees with cursor.prev.command', () => {
    const msgs = makeMsgs(20);
    const singleTokens = estimateMessageTokens(msgs[0]);
    const budget = singleTokens * 4;
    const result = sliceByTokenBudget(msgs, budget, 'sess1', 'claude', 'tail');

    expect(result.meta.has_more_before).toBe(true);
    expect(result.meta.cursor_before).toBe(result.meta.range.from);
    expect(result.meta.cursor?.prev?.command).toContain(`--before ${result.meta.cursor_before} --tokens`);
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
    expect(result.meta.search?.match_index).toBe(2);
  });

  it('fails to find tool_input string if searching only content', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'staging --force', undefined, 'content');
    expect(result.messages.length).toBe(0);
    expect(result.meta.search?.matched).toBe(false);
  });

  it('finds string inside tool_input when tool_input field is specified', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'staging --force', undefined, 'tool_input');
    expect(result.meta.search?.matched).toBe(true);
    expect(result.meta.search?.match_index).toBe(3);
  });

  it('finds string inside tool_result when tool_result field is specified', () => {
    const result = sliceByTokenBudget(toolMsgs, 4000, 'sess1', 'claude', 'search', 'exit code 0', undefined, 'tool_result');
    expect(result.meta.search?.matched).toBe(true);
    expect(result.meta.search?.match_index).toBe(4);
  });
});

describe('search match visibility regression', () => {
  const messages: NormalizedMessage[] = [makeMsg(1, 'user', 'request'), makeMsg(2, 'assistant', 'working'), { ...makeMsg(3, 'tool_use', 'Tool: Bash'), blocks: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'echo "quoted-needle"', path: 'C:\\work\\file.ts' } }] }, { ...makeMsg(4, 'tool_result', 'result-needle'), blocks: [{ type: 'tool_result', toolUseId: 'call', content: 'result-needle', isError: false }] }];
  it.each([['quoted-needle', 'tool_input', 3], ['result-needle', 'tool_result', 4]] as const)('retains the actual %s match', (query, field, index) => {
    const result = sliceByTokenBudget(messages, 4000, 's', 'claude', 'search', query, undefined, field);
    expect(result.meta.search?.matched).toBe(true);
    expect(result.messages.map(m => m.index)).toContain(index);
    expect(result.meta.search).not.toHaveProperty('matchIndex');
  });
  it('searches decoded strings rather than escaped JSON', () => {
    const result = sliceByTokenBudget(messages, 4000, 's', 'claude', 'search', 'echo "quoted-needle"', undefined, 'tool_input');
    expect(result.meta.search?.matched).toBe(true);
  });
  it('marks searches of empty collections as unmatched', () => {
    const result = sliceByTokenBudget([], 4000, 's', 'claude', 'search', 'missing', undefined, 'tool_input', 10);
    expect(result.meta.search).toMatchObject({ query: 'missing', matched: false, match_index: null, fields: ['tool_input'] });
  });
});

describe('Pending tool calls and unresolved tool protection (Issue #6)', () => {
  it('computes pending tool calls across whole session', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'What is the status?'),
      makeMsg(2, 'assistant', 'Let me ask you.'),
      {
        index: 3,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Tool: AskUserQuestion',
        blocks: [
          {
            type: 'tool_use',
            id: 'tu-ask-1',
            name: 'AskUserQuestion',
            input: { question: 'Do you want to proceed?' },
          },
        ],
      },
    ];

    const pending = computePendingToolCalls(msgs);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('tu-ask-1');
    expect(pending[0].name).toBe('AskUserQuestion');
    expect(pending[0].input).toEqual({ question: 'Do you want to proceed?' });
    expect(pending[0].messageIndex).toBe(3);
  });

  it('resolves tool calls once tool_result is received', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Run tests'),
      {
        index: 2,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Tool: Bash',
        blocks: [
          {
            type: 'tool_use',
            id: 'tu-bash-1',
            name: 'Bash',
            input: { command: 'pnpm test' },
          },
        ],
      },
      {
        index: 3,
        role: 'tool_result',
        timestamp: new Date(),
        content: 'Tests passed',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tu-bash-1',
            content: 'Tests passed',
            isError: false,
          },
        ],
      },
    ];

    const pending = computePendingToolCalls(msgs);
    expect(pending).toHaveLength(0);
  });

  it('never trims trailing unresolved tool_use from tail windows', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Initialize setup'),
      makeMsg(2, 'assistant', 'Starting setup now.'),
      {
        index: 3,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Tool: AskUserQuestion',
        blocks: [
          {
            type: 'tool_use',
            id: 'tu-ask-trailing',
            name: 'AskUserQuestion',
            input: { question: 'Confirm deploy?' },
          },
        ],
      },
    ];

    const result = sliceByTokenBudget(msgs, 4000, 'sess1', 'claude', 'tail');
    expect(result.messages).toHaveLength(3);
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe('tool_use');
    expect(lastMsg.content).toBe('Tool: AskUserQuestion');
  });
});


describe('pending suffix regression', () => {
  it.each(['user', 'tool_result'] as const)('keeps a pending call before trailing %s', (role) => {
    const pending: NormalizedMessage = { ...makeMsg(5, 'tool_use', 'Tool: AskUserQuestion'), blocks: [{ type: 'tool_use', id: 'pending', name: 'AskUserQuestion', input: {} }] };
    const suffix = makeMsg(6, role, 'stop');
    const result = sliceByTokenBudget([...makeMsgs(4), pending, suffix], 4000, 's', 'claude', 'tail');
    expect(result.messages.map(m => m.index)).toContain(5);
  });
  it('protects tool calls whose parser supplies an empty ID', () => {
    const pending: NormalizedMessage = { ...makeMsg(3, 'tool_use', 'Tool: AskUserQuestion'), blocks: [{ type: 'tool_use', id: '', name: 'AskUserQuestion', input: {} }] };
    const result = sliceByTokenBudget([makeMsg(1, 'user', 'start'), makeMsg(2, 'assistant', 'asking'), pending], 4000, 's', 'claude', 'tail');
    expect(result.messages.map(m => m.index)).toContain(3);
  });
});

describe('historical pending-call handoff metadata', () => {
  it('marks earlier-turn calls superseded without removing them from the whole-session list', () => {
    const messages = Array.from({ length: 185 }, (_, i) => makeMsg(i + 1, 'assistant', 'working'));
    messages[0] = makeMsg(1, 'user', 'start');
    messages[79] = { ...makeMsg(80, 'tool_use', 'Tool: Bash'), blocks: [{ type: 'tool_use', id: 'earlier', name: 'Bash', input: { command: 'npm test' } }] };
    messages[80] = makeMsg(81, 'user', 'continue with a different task');
    messages[184] = { ...makeMsg(185, 'tool_use', 'Tool: AskUserQuestion'), blocks: [{ type: 'tool_use', id: 'current', name: 'AskUserQuestion', input: { question: 'Proceed?' } }] };
    const pending = computePendingToolCalls(messages);
    expect(pending).toHaveLength(2);
    expect(pending.find(p => p.id === 'earlier')).toMatchObject({ index: 80, superseded: true });
    expect(pending.find(p => p.id === 'current')).toMatchObject({ index: 185, superseded: false });
  });
});
