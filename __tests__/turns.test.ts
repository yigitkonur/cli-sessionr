import { describe, it, expect } from 'vitest';
import { segmentTurns, getTurn } from '../src/turns.js';
import type { NormalizedMessage, NormalizedSession } from '../src/types.js';

function makeMsg(index: number, role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result', content: string, source?: string): NormalizedMessage {
  return {
    index,
    role,
    timestamp: new Date(),
    content,
    blocks: [{ type: 'text', text: content }],
    source,
  };
}

function makeSession(messages: NormalizedMessage[]): NormalizedSession {
  return {
    id: 'test-session-1',
    source: 'claude',
    filePath: '/tmp/test.jsonl',
    metadata: {
      cwd: '/root/dev',
      model: 'claude-3-5-sonnet',
      createdAt: new Date(),
      updatedAt: new Date(),
      fileBytes: 1000,
      rawLineCount: messages.length,
    },
    messages,
    stats: {
      totalMessages: messages.length,
      byRole: {
        user: messages.filter((m) => m.role === 'user').length,
        assistant: messages.filter((m) => m.role === 'assistant').length,
        system: messages.filter((m) => m.role === 'system').length,
        toolUse: messages.filter((m) => m.role === 'tool_use').length,
        toolResult: messages.filter((m) => m.role === 'tool_result').length,
      },
      byBlockType: {},
    },
  };
}

describe('Turn Segmentation (Issue #12)', () => {
  it('segments session with 3 user prompts into exactly 3 turns', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'First prompt'),
      makeMsg(2, 'assistant', 'First reply'),
      makeMsg(3, 'user', 'Second prompt'),
      makeMsg(4, 'assistant', 'Second reply'),
      makeMsg(5, 'user', 'Third prompt'),
      makeMsg(6, 'assistant', 'Third reply'),
    ];
    const session = makeSession(msgs);
    const turns = segmentTurns(session);

    expect(turns).toHaveLength(3);
    expect(turns[0].id).toBe('turn-1');
    expect(turns[0].turnIndex).toBe(1);
    expect(turns[0].startIndex).toBe(1);
    expect(turns[0].endIndex).toBe(2);
    expect(turns[0].prompt.text).toBe('First prompt');

    expect(turns[1].id).toBe('turn-2');
    expect(turns[1].turnIndex).toBe(2);
    expect(turns[1].startIndex).toBe(3);
    expect(turns[1].endIndex).toBe(4);
    expect(turns[1].prompt.text).toBe('Second prompt');

    expect(turns[2].id).toBe('turn-3');
    expect(turns[2].turnIndex).toBe(3);
    expect(turns[2].startIndex).toBe(5);
    expect(turns[2].endIndex).toBe(6);
    expect(turns[2].prompt.text).toBe('Third prompt');
  });

  it('excludes injected system reminders and local commands from starting turns', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', '<system-reminder>Injected system prompt</system-reminder>'),
      makeMsg(2, 'user', 'Actual prompt from user'),
      makeMsg(3, 'assistant', 'Response'),
      makeMsg(4, 'user', '/compact'),
      makeMsg(5, 'assistant', 'Compacting...'),
    ];
    const session = makeSession(msgs);
    const turns = segmentTurns(session);

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.text).toBe('Actual prompt from user');
    expect(turns[0].startIndex).toBe(2);
  });

  it('retrieves turn by index, slug, and "last"', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Prompt A'),
      makeMsg(2, 'assistant', 'Reply A'),
      makeMsg(3, 'user', 'Prompt B'),
      makeMsg(4, 'assistant', 'Reply B'),
    ];
    const session = makeSession(msgs);
    const turns = segmentTurns(session);

    const turn1 = getTurn(turns, 1);
    expect(turn1.id).toBe('turn-1');
    expect(turn1.prompt.text).toBe('Prompt A');

    const turn2BySlug = getTurn(turns, 'turn-2');
    expect(turn2BySlug.id).toBe('turn-2');
    expect(turn2BySlug.prompt.text).toBe('Prompt B');

    const lastTurn = getTurn(turns, 'last');
    expect(lastTurn.id).toBe('turn-2');
    expect(lastTurn.prompt.text).toBe('Prompt B');
  });

  it('throws on out-of-bounds turn index or non-existent slug', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Prompt A'),
      makeMsg(2, 'assistant', 'Reply A'),
    ];
    const session = makeSession(msgs);

    expect(() => getTurn(session, 99)).toThrow();
    expect(() => getTurn(session, 'turn-99')).toThrow();
  });

  it('handles empty session with 0 turns gracefully', () => {
    const session = makeSession([]);
    const turns = segmentTurns(session);
    expect(turns).toHaveLength(0);
    expect(() => getTurn(session, 'last')).toThrow();
  });
});
