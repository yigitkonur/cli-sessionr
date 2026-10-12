import { describe, it, expect, vi } from 'vitest';
import { segmentTurns, getTurn, extractTurnFacts, extractTurnFilesChanged } from '../src/turns.js';
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


describe('Turn review regressions', () => {
  const use = (index: number, id: string, name: string, input: Record<string, unknown>): NormalizedMessage => ({ ...makeMsg(index, 'tool_use', name), blocks: [{type: 'tool_use', id, name, input}] });
  const result = (index: number, id: string, isError = false, content = ''): NormalizedMessage => ({ ...makeMsg(index, 'tool_result', content), blocks: [{type: 'tool_result', toolUseId: id, isError, content}] });
  it('rejects non-finite and fractional numeric turn selectors', () => {
    const turns = segmentTurns([makeMsg(1, 'user', 'prompt')]);
    for (const value of [NaN, Infinity, 1.5]) expect(() => getTurn(turns, value)).toThrow();
  });
  it('counts failed commands and failed edits once each', () => {
    const facts = extractTurnFacts([use(1,'bash','Bash',{command:'npm test'}), use(2,'edit','Edit',{file_path:'a.ts'}), result(3,'bash',true,'exit code 2'), result(4,'edit',true,'permission denied')]);
    expect(facts.errorCount).toBe(2);
    expect(facts.filesChanged.edited).toEqual([]);
  });
  it('only reports successful edits, not failed or pending writes', () => {
    const messages = [use(1,'ok','Edit',{file_path:'a.ts'}), result(2,'ok'), use(3,'fail','Write',{file_path:'b.ts'}), result(4,'fail',true),use(5,'pending','Edit',{file_path:'c.ts'})];
    expect(extractTurnFilesChanged(messages)).toEqual({created:[],edited:['a.ts'],deleted:[]});
  });
  it('classifies each file in a multi-file git diff independently', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts\n+new';
    expect(extractTurnFilesChanged([use(1,'patch','apply_patch',{input:patch}),result(2,'patch')])).toEqual({created:['b.ts'],edited:['a.ts'],deleted:[]});
  });
  it('matches late results to the launching turn without counting them twice', () => {
    const turns=segmentTurns([makeMsg(1,'user','one'),use(2,'cmd','Bash',{command:'npm test'}),makeMsg(3,'user','two'),result(4,'cmd',true,'exit code 1'),makeMsg(5,'assistant','done')]);
    expect(turns[0].pendingToolCalls).toBeUndefined();
    expect(turns[0].commands[0].exitCode).toBe(1);
    expect(turns[0].errorCount).toBe(1);
    expect(turns[1].errorCount).toBe(0);
  });
  it('does not complete an earlier turn while a tool remains pending', () => {
    const turns=segmentTurns([makeMsg(1,'user','one'),use(2,'cmd','Bash',{command:'sleep 7'}),makeMsg(3,'user','two'),makeMsg(4,'assistant','done')]);
    expect(turns[0].completed).toBe(false);
  });
  it('recognizes tool-use interruptions without scanning tool output', () => {
    const turns=segmentTurns([makeMsg(1,'user','one'),makeMsg(2,'user','[Request interrupted by user for tool use]'),makeMsg(3,'user','two'),result(4,'unknown',false,'source: [Request interrupted by user]'),makeMsg(5,'assistant','done')]);
    expect(turns[0].interrupted).toBe(true);
    expect(turns[1].interrupted).toBe(false);
    expect(turns[1].finalMessageIndex).toBe(5);
  });
  it('infers zero for a successful command result without an explicit status', () => {
    expect(extractTurnFacts([use(1,'cmd','Bash',{command:'pwd'}),result(2,'cmd',false,'/repo')]).commands[0].exitCode).toBe(0);
  });
});


describe('Source event turn regressions', () => {
  it('uses Codex UserMessage provenance, folds steers, and preserves terminal facts', async () => {
    const common = await import('../src/parsers/common.js');
    const { parseCodexSession } = await import('../src/parsers/codex.js');
    const at='2026-10-12T00:00:00Z';
    const response = (role: string, text: string, phase?: string) => ({timestamp:at,type:'response_item',payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
    const event = (type: string, extra={}) => ({timestamp:at,type:'event_msg',payload:{type,...extra}});
    const user = (text: string) => event('item_completed',{item:{type:'UserMessage',content:[{type:'text',text}]}});
    const records = [event('task_started'),response('user','injected context'),response('user','prompt'),user('prompt'),response('assistant','working','commentary'),response('user','steer'),user('steer'),response('assistant','done','final_answer'),event('task_complete',{duration_ms:1234}),event('task_started'),response('user','/model custom'),user('/model custom'),response('assistant','working','commentary'),event('turn_aborted',{duration_ms:4321})];
    vi.spyOn(common,'readJsonlFile').mockResolvedValue(records);
    vi.spyOn(common,'getFileStats').mockResolvedValue({bytes:100,lines:records.length});
    try {
      const turns=segmentTurns(await parseCodexSession('/scratch/source.jsonl'));
      expect(turns).toHaveLength(2);
      expect(turns.map(t=>t.prompt.text)).toEqual(['prompt','/model custom']);
      expect(turns[0].durationMs).toBe(1234);
      expect(turns[0].completed).toBe(true);
      expect(turns[1].interrupted).toBe(true);
      expect(turns[1].completed).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });
  it('does not treat Codex commentary with a resolved tool as a completed final response', async () => {
    const common = await import('../src/parsers/common.js');
    const { parseCodexSession } = await import('../src/parsers/codex.js');
    const at='2026-10-12T00:00:00Z';
    const records=[{timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'prompt'}]}},{timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'working'}]}}];
    vi.spyOn(common,'readJsonlFile').mockResolvedValue(records);vi.spyOn(common,'getFileStats').mockResolvedValue({bytes:100,lines:2});
    try { expect(segmentTurns(await parseCodexSession('/scratch/running.jsonl'))[0].completed).toBe(false); } finally {vi.restoreAllMocks();}
  });
  it('retains full Codex patch input for per-turn file extraction', async () => {
    const common = await import('../src/parsers/common.js');const {parseCodexSession}=await import('../src/parsers/codex.js');const at='2026-10-12T00:00:00Z';
    const patch='*** Begin Patch\n*** Update File: a.ts\n@@\n+'+'x'.repeat(350)+'\n*** Add File: b.ts\n+new\n*** End Patch';
    const records=[{timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'edit'}]}},{timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',call_id:'p',input:patch}},{timestamp:at,type:'response_item',payload:{type:'custom_tool_call_output',call_id:'p',output:'Success'}}];
    vi.spyOn(common,'readJsonlFile').mockResolvedValue(records);vi.spyOn(common,'getFileStats').mockResolvedValue({bytes:100,lines:3});
    try { expect(segmentTurns(await parseCodexSession('/scratch/patch.jsonl'))[0].filesChanged).toEqual({created:['b.ts'],edited:['a.ts'],deleted:[]}); } finally {vi.restoreAllMocks();}
  });
});


describe('Shell edit facts', () => {
  it('tracks all literal operands of successful simple commands without matching quoted scripts', () => {
    const messages: NormalizedMessage[] = [];
    for (const [id,command] of [['touch','touch a.ts "b file.ts"'],['rm','rm -f c.ts d.ts'],['echo','echo "rm fake.ts"']]) {
      messages.push({...makeMsg(messages.length+1,'tool_use','Bash'),blocks:[{type:'tool_use',id,name:'Bash',input:{command}}]}, {...makeMsg(messages.length+2,'tool_result','ok'),blocks:[{type:'tool_result',toolUseId:id,isError:false,content:'ok'}]});
    }
    expect(extractTurnFilesChanged(messages)).toEqual({created:['a.ts','b file.ts'],edited:[],deleted:['c.ts','d.ts']});
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
      ...['call-write-1', 'call-edit-1', 'call-del-1'].map((toolUseId, i): NormalizedMessage => ({
        ...makeMsg(5 + i, 'tool_result', 'Success'),
        blocks: [{ type: 'tool_result', toolUseId, isError: false, content: 'Success' }],
      })),
      makeMsg(8, 'assistant', 'Done with edits.'),
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


it('reports two successful edits and a non-zero test exit in the same turn (Issue #13 acceptance)', () => {
  const messages: NormalizedMessage[] = [makeMsg(1,'user','Edit both files and test')];
  for (const [id,name,input,isError,content] of [
    ['edit-a','Edit',{file_path:'a.ts'},false,'Success'],
    ['edit-b','Edit',{file_path:'b.ts'},false,'Success'],
    ['test','Bash',{command:'npm test'},true,'exit code 2'],
  ] as const) {
    messages.push({...makeMsg(messages.length+1,'tool_use',name),blocks:[{type:'tool_use',id,name,input}]});
    messages.push({...makeMsg(messages.length+1,'tool_result',content),blocks:[{type:'tool_result',toolUseId:id,isError,content}]});
  }
  const turn=segmentTurns(messages)[0];
  expect(turn.filesChanged.edited).toEqual(['a.ts','b.ts']);
  expect(turn.commands[0].exitCode).toBe(2);
  expect(turn.errorCount).toBe(1);
});
