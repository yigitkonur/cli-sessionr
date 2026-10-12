import { describe, it, expect } from 'vitest';
import { segmentTurns, getTurn, deriveContextWindow } from '../src/turns.js';
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

describe('Turn Execution Facts (Issue #13)', () => {
  it('extracts files changed with created, edited, and deleted classifications', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Implement changes'),
      {
        index: 2,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Write file',
        blocks: [
          {
            type: 'tool_use',
            id: 'call-write-1',
            name: 'write_to_file',
            input: { TargetFile: '/root/dev/src/newfile.ts', CodeContent: 'hello' },
          },
        ],
      },
      {
        index: 3,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Edit file',
        blocks: [
          {
            type: 'tool_use',
            id: 'call-edit-1',
            name: 'replace_file_content',
            input: { TargetFile: '/root/dev/src/existing.ts', ReplacementContent: 'updated' },
          },
        ],
      },
      {
        index: 4,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Delete file',
        blocks: [
          {
            type: 'tool_use',
            id: 'call-del-1',
            name: 'delete_file',
            input: { path: '/root/dev/src/obsolete.ts' },
          },
        ],
      },
      makeMsg(5, 'assistant', 'Done with edits.'),
    ];

    const session = makeSession(msgs);
    const turns = segmentTurns(session);
    expect(turns).toHaveLength(1);
    const turn = turns[0];

    expect(turn.filesChanged.created).toEqual(['/root/dev/src/newfile.ts']);
    expect(turn.filesChanged.edited).toEqual(['/root/dev/src/existing.ts']);
    expect(turn.filesChanged.deleted).toEqual(['/root/dev/src/obsolete.ts']);
  });

  it('extracts executed commands with exit codes and error status', () => {
    const t0 = new Date('2026-10-12T01:00:00Z');
    const t1 = new Date('2026-10-12T01:00:05Z');
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Run tests'),
      {
        index: 2,
        role: 'tool_use',
        timestamp: t0,
        content: 'Tool: Bash',
        blocks: [
          {
            type: 'tool_use',
            id: 'call-bash-1',
            name: 'Bash',
            input: { command: 'pnpm test' },
          },
        ],
      },
      {
        index: 3,
        role: 'tool_result',
        timestamp: t1,
        content: 'Tests failed with exit code 1',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'call-bash-1',
            content: 'Tests failed with exit code 1',
            isError: true,
          },
        ],
      },
      makeMsg(4, 'assistant', 'Tests failed, investigating.'),
    ];

    const session = makeSession(msgs);
    const turns = segmentTurns(session);
    expect(turns).toHaveLength(1);
    const turn = turns[0];

    expect(turn.commands).toHaveLength(1);
    expect(turn.commands[0].cmd).toBe('pnpm test');
    expect(turn.commands[0].exitCode).toBe(1);
    expect(turn.commands[0].isError).toBe(true);
    expect(turn.commands[0].durationMs).toBe(5000);
    expect(turn.errorCount).toBe(1);
  });

  it('tracks pending tool calls at turn boundary', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Should we proceed?'),
      makeMsg(2, 'assistant', 'Let me ask you.'),
      {
        index: 3,
        role: 'tool_use',
        timestamp: new Date(),
        content: 'Tool: AskUserQuestion',
        blocks: [
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'AskUserQuestion',
            input: { question: 'Deploy now?' },
          },
        ],
      },
    ];

    const session = makeSession(msgs);
    const turns = segmentTurns(session);
    expect(turns).toHaveLength(1);
    const turn = turns[0];

    expect(turn.completed).toBe(false);
    expect(turn.pendingToolCalls).toHaveLength(1);
    expect(turn.pendingToolCalls![0].name).toBe('AskUserQuestion');
  });
});

describe('Turn Token Usage and Context Window (Issue #8)', () => {
  it('derives context window size correctly from model and metadata', () => {
    expect(deriveContextWindow('claude-3-5-sonnet')).toBe(200_000);
    expect(deriveContextWindow('claude-3-7-sonnet-20250219')).toBe(200_000);
    expect(deriveContextWindow('gpt-4o')).toBe(128_000);
    expect(deriveContextWindow('gemini-1.5-pro')).toBe(2_000_000);
    expect(deriveContextWindow('unknown-model')).toBe(128_000);
    expect(deriveContextWindow('unknown-model', { contextWindow: 32_768 } as any)).toBe(32_768);
  });

  it('extracts per-turn token usage including contextTokens, cacheRead, cacheWrite', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Analyze data'),
      {
        index: 2,
        role: 'assistant',
        timestamp: new Date(),
        content: 'Analyzing...',
        blocks: [{ type: 'text', text: 'Analyzing...' }],
        usage: {
          input_tokens: 1500,
          output_tokens: 300,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
          context_tokens: 2500,
        },
      } as any,
    ];

    const session = makeSession(msgs);
    const turns = segmentTurns(session);
    expect(turns).toHaveLength(1);
    const turn = turns[0];

    expect(turn.usage).toBeDefined();
    expect(turn.usage!.input).toBe(1500);
    expect(turn.usage!.output).toBe(300);
    expect(turn.usage!.cacheRead).toBe(800);
    expect(turn.usage!.cacheWrite).toBe(200);
    expect(turn.usage!.contextTokens).toBe(2500);
  });

  it('surfaces reasoningEffort and rateLimits on turn when present in metadata or message', () => {
    const rateLimits = {
      primary: { usedPercent: 45, windowMinutes: 60, resetsAt: '2026-10-12T03:00:00.000Z' },
    };
    const msgs: NormalizedMessage[] = [
      makeMsg(1, 'user', 'Run deep reasoning task'),
      {
        index: 2,
        role: 'assistant',
        timestamp: new Date(),
        content: 'Reasoned answer',
        blocks: [{ type: 'text', text: 'Reasoned answer' }],
        rateLimits,
      } as any,
    ];

    const session = makeSession(msgs);
    session.metadata.reasoningEffort = 'high';
    session.metadata.model = 'o3-mini';

    const turns = segmentTurns(session);
    expect(turns).toHaveLength(1);
    const turn = turns[0];

    expect(turn.reasoningEffort).toBe('high');
    expect(turn.contextWindowSize).toBe(200_000);
    expect(turn.rateLimits).toEqual(rateLimits);
  });
});
