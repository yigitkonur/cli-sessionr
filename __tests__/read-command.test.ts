import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCommand } from '../src/commands/read.js';
import { loadSession } from '../src/discovery.js';
import { EXIT } from '../src/errors.js';
import type { NormalizedMessage, NormalizedSession } from '../src/types.js';

vi.mock('../src/discovery.js', () => ({
  loadSession: vi.fn(),
}));

function makeMessage(index: number, content = `message ${index}`): NormalizedMessage {
  return {
    index,
    role: index % 2 === 0 ? 'assistant' : 'user',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    content,
    blocks: [{ type: 'text', text: content }],
  };
}

function makeSession(messages: NormalizedMessage[]): NormalizedSession {
  return {
    id: 'sess-test',
    source: 'codex',
    filePath: '/tmp/session.jsonl',
    metadata: {
      cwd: '/tmp/project',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      fileBytes: 1,
      rawLineCount: messages.length,
    },
    messages,
    stats: {
      totalMessages: messages.length,
      byRole: {
        user: messages.filter((m) => m.role === 'user').length,
        assistant: messages.filter((m) => m.role === 'assistant').length,
        system: 0,
        toolUse: 0,
        toolResult: 0,
      },
      byBlockType: { text: messages.length, thinking: 0, toolUse: 0, toolResult: 0 },
      tokenUsage: { input: 0, output: 0 },
      toolFrequency: [],
      filesModified: [],
    },
  };
}

// Phase 2: read command now routes JSON envelopes (success + failure) through
// emit() → process.stdout.write, not console.log/console.error. Capture stdout
// directly so the test reflects the live IO contract.
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return { chunks, restore: () => spy.mockRestore() };
}

describe('readCommand validation', () => {
  let stdout: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    process.exitCode = undefined;
    stdout = captureStdout();
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1), makeMessage(2)]));
  });

  afterEach(() => {
    stdout.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  function parseEnvelope(): Record<string, unknown> {
    return JSON.parse(stdout.chunks.join(''));
  }

  it('returns INVALID_TOKEN_BUDGET for non-positive tokens', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 0 });

    const body = parseEnvelope() as { ok: boolean; schema_version: string; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.schema_version).toBe('v2');
    expect(body.error.code).toBe('INVALID_TOKEN_BUDGET');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('returns INVALID_ROLE for unknown roles before slicing', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', role: 'user,banana' });

    const body = parseEnvelope() as {
      ok: boolean;
      error: { code: string; detail: { unknown: string[]; valid: string[] } };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ROLE');
    expect(body.error.detail.unknown).toEqual(['banana']);
    expect(body.error.detail.valid).toEqual(['user', 'assistant', 'system', 'tool_use', 'tool_result']);
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('returns INVALID_ANCHOR for unknown anchors', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'sideways' });

    const body = parseEnvelope() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ANCHOR');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('requires --search with --anchor search', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'search' });

    const body = parseEnvelope() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ANCHOR_USAGE');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('marks truncated token slices as partial and exits PARTIAL', async () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      makeMessage(i + 1, `message ${i + 1} ${'x'.repeat(100)}`),
    );
    vi.mocked(loadSession).mockResolvedValue(makeSession(messages));

    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 200 });

    const body = parseEnvelope() as {
      ok: boolean;
      schema_version: string;
      meta: { partial?: boolean; has_more_after?: boolean; has_more_before?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('v2');
    expect(body.meta.partial).toBe(true);
    expect(body.meta.has_more_after || body.meta.has_more_before).toBe(true);
    expect(process.exitCode).toBe(EXIT.PARTIAL);
  });
  it('filters roles within the selected turn and emits snake_case metadata', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(Array.from({length:6},(_,i)=>makeMessage(i+1))));
    await readCommand('sess-test', undefined, undefined, {output:'json',turn:'2',role:'assistant'});
    const body=parseEnvelope() as any;
    expect(body.result.messages.map((m:any)=>m.index)).toEqual([4]);
    expect(body.meta.turn.start_index).toBe(3);
    expect(body.meta.turn.startIndex).toBeUndefined();
    expect(body.meta.partial).toBe(false);
    expect(process.exitCode).not.toBe(EXIT.PARTIAL);
  });
  it('keeps tool activity at the end of a running last turn', async () => {
    const messages=[makeMessage(1),makeMessage(2),{...makeMessage(3),role:'tool_use' as const,blocks:[{type:'tool_use' as const,id:'sleep',name:'Bash',input:{command:'sleep 7'}}]}];
    vi.mocked(loadSession).mockResolvedValue(makeSession(messages));
    await readCommand('sess-test', undefined, undefined, {output:'json',turn:'last'});
    const body=parseEnvelope() as any;
    expect(body.result.messages.map((m:any)=>m.index)).toEqual([1,2,3]);
    expect(body.meta.partial).toBe(false);
  });
  it('rejects unsupported turn/page and turn/batch combinations', async () => {
    for (const extra of [{page:1},{batch:'/not-read'}]) {
      stdout.chunks.length=0;
      await readCommand('sess-test', undefined, undefined, {output:'json',turn:'last',...extra});
      expect((parseEnvelope() as any).error.code).toBe('INVALID_TURN_USAGE');
    }
  });

  it('keeps pending tool input opaque while externalizing turn keys', async () => {
    const msg={...makeMessage(2),role:'tool_use' as const,blocks:[{type:'tool_use' as const,id:'pending',name:'Custom',input:{filePath:'opaque',exitCode:17}}]};
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1),msg]));
    await readCommand('sess-test',undefined,undefined,{output:'json',turn:'last',detail:'full'});
    const body=parseEnvelope() as any;
    expect(body.meta.turn.pending_tool_calls[0].input).toEqual({filePath:'opaque',exitCode:17});
    expect(body.meta.turn.facts).toBeUndefined();
    expect(body.meta.turn.context_window).toBeUndefined();
  });

  it('does not repeat large prompts or pending input in meta detail', async () => {
    const large='x'.repeat(20000);
    const msg={...makeMessage(2),role:'tool_use' as const,blocks:[{type:'tool_use' as const,id:'pending',name:'Custom',input:{patch:large}}]};
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1,large),msg]));
    await readCommand('sess-test',undefined,undefined,{output:'json',turn:'last',detail:'meta',tokens:100});
    const body=parseEnvelope() as any;
    expect(body.meta.turn.prompt.text).toBe('');
    expect(body.meta.turn.pending_tool_calls[0].input).toBeUndefined();
    expect(stdout.chunks.join('').length).toBeLessThan(10000);
  });

});

describe('exclusive cursor walks', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
  async function run(options: Parameters<typeof readCommand>[3]) {
    const out = captureStdout(); await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 120, ...options });
    const body = JSON.parse(out.chunks.join('')); out.restore(); return body;
  }
  it.each(['head', 'tail'] as const)('walks every index exactly once from %s using printed cursor commands', async (anchor) => {
    const messages = Array.from({ length: 31 }, (_, i) => makeMessage(i + 1, 'x'.repeat(100)));
    vi.mocked(loadSession).mockResolvedValue(makeSession(messages));
    const collected: number[] = []; let opts: Parameters<typeof readCommand>[3] = { anchor }; let pages = 0;
    while (pages++ < 100) {
      const body = await run(opts); collected.push(...body.result.messages.map((m: NormalizedMessage) => m.index));
      expect(body.meta.total_messages).toBe(31);
      const cursor = body.meta.cursor[anchor === 'head' ? 'next' : 'prev']; if (!cursor) break;
      const match = cursor.command.match(/--(after|before) (\d+)/)!;
      opts = { [match[1]]: Number(match[2]) };
    }
    expect(pages).toBeGreaterThan(2); expect(pages).toBeLessThan(100);
    expect(collected.slice().sort((a,b) => a-b)).toEqual(messages.map(m => m.index));
    expect(new Set(collected).size).toBe(collected.length);
  });
  it('applies role-filtered cursors to message indices, not array positions', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(Array.from({ length: 10 }, (_, i) => makeMessage(i + 1))));
    const after = await run({ role: 'assistant', after: 4, tokens: 4000 });
    expect(after.result.messages.map((m: NormalizedMessage) => m.index)).toEqual([6,8,10]);
    const before = await run({ role: 'assistant', before: 6, tokens: 4000 });
    expect(before.result.messages.map((m: NormalizedMessage) => m.index)).toEqual([2,4]);
  });
  it('empty cursor responses retain the conditional-read contract and coherent flags', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1), makeMessage(2)]));
    const first = await run({ after: 2 });
    expect(first.meta.has_more_before).toBe(false); expect(first.meta.has_more_after).toBe(false);
    const second = await run({ after: 2, ifChanged: first.meta.etag });
    expect(second.result.unchanged).toBe(true); expect(process.exitCode).toBe(EXIT.NO_CHANGES);
  });
});

vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('sess-test\n') }));
describe('search envelope regression', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
  const tools: NormalizedMessage[] = [makeMessage(1, 'needle'), makeMessage(2), { ...makeMessage(3), role: 'tool_use', content: 'Tool: Bash', blocks: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'needle' } }] }];
  async function run(options: Parameters<typeof readCommand>[3]) {
    const out = captureStdout(); await readCommand('sess-test', undefined, undefined, { output: 'json', ...options });
    const text = out.chunks.join(''); out.restore(); return options?.batch ? JSON.parse(text.trim().split('\n').at(-1)!) : JSON.parse(text);
  }
  it.each([false, true])('honors tool-input search and canonical metadata (batch=%s)', async (batch) => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(tools));
    const body = await run({ search: 'needle', searchIn: 'tool_input', ...(batch ? { batch: 'ids.txt' } : {}) });
    expect(body.meta.search).toMatchObject({ matched: true, match_index: 3, fields: ['tool_input'] });
    expect(body.meta.search).not.toHaveProperty('matchIndex');
    expect(body.result.messages.map((m: NormalizedMessage) => m.index)).toContain(3);
  });
  it('rejects invalid batch search fields', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(tools));
    const body = await run({ batch: 'ids.txt', search: 'needle', searchIn: 'invalid' });
    expect(body.ok).toBe(false);
    expect(process.exitCode).toBe(EXIT.USAGE);
  });
  it.each([false, true])('marks empty search results explicitly (empty-session=%s)', async (empty) => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(empty ? [] : tools));
    const body = await run({ search: 'missing', ...(empty ? {} : { role: 'system' }) });
    expect(body, JSON.stringify(body)).toHaveProperty('meta.search');
    expect(body.meta.search).toMatchObject({ matched: false, match_index: null });
    expect(body.result.notice).toContain('no matches');
  });
  it('prints a no-match text notice only once across stdout and stderr', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(tools));
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const out = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'text', search: 'missing' });
    const notices = (out.chunks.join('') + err.join('')).match(/yielded no matches/g) ?? [];
    out.restore();
    expect(notices).toHaveLength(1);
  });
  it('search fields participate in conditional-read ETags', async () => {
    vi.mocked(loadSession).mockResolvedValue(makeSession(tools));
    const content = await run({ search: 'needle', searchIn: 'content' });
    const input = await run({ search: 'needle', searchIn: 'tool_input', ifChanged: content.meta.etag });
    expect(input.result.unchanged).not.toBe(true);
    expect(input.meta.etag).not.toBe(content.meta.etag);
  });
});

describe('19-D Claude preset filtering', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = undefined; });

  it.each(['minimal', 'standard', 'full'] as const)('filters non-prompts before slicing at %s without renumbering', async (preset) => {
    const sources = ['prompt', 'interrupt', 'local_command', 'system', 'task_notification', 'queued', 'prompt'] as const;
    const messages = sources.map((source, i) => ({
      ...makeMessage(i + 1), source,
      role: (source === 'system' || source === 'task_notification' ? 'system' : 'user') as NormalizedMessage['role'],
    }));
    const session = { ...makeSession(messages), source: 'claude' as const };
    vi.mocked(loadSession).mockResolvedValue(session);
    const stdout = captureStdout();
    try {
      await readCommand('sess-test', undefined, undefined, { output: 'json', preset, tokens: 10000 });
      const all = JSON.parse(stdout.chunks.join(''));
      expect(all.result.messages.map((m: { index: number }) => m.index)).toEqual(preset === 'full' ? [1, 2, 3, 4, 5, 6, 7] : [1, 6, 7]);
      stdout.chunks.length = 0;
      await readCommand('sess-test', undefined, undefined, { output: 'json', preset, role: 'user', tokens: 10000 });
      const users = JSON.parse(stdout.chunks.join(''));
      expect(users.result.messages.map((m: { index: number }) => m.index)).toEqual(preset === 'full' ? [1, 2, 3, 6, 7] : [1, 6, 7]);
    } finally { stdout.restore(); }
  });
});

describe('pending envelope regression', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
  it('bounds large pending inputs in meta detail and retains complete inputs in full preset', async () => {
    const input = { file_path: '/tmp/fake', content: 'A'.repeat(50000) };
    const pending: NormalizedMessage = { ...makeMessage(3), role: 'tool_use', content: 'Tool: Write', blocks: [{ type: 'tool_use', id: 'large', name: 'Write', input }] };
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1), makeMessage(2), pending]));
    const thin = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 100, detail: 'meta' });
    const text = thin.chunks.join(''); thin.restore();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    const body = JSON.parse(text);
    expect(body.meta.pending_tool_call_count).toBe(1);
    expect(body.meta.pending_tool_call_ids).toEqual(['large']);
    expect(body.meta).not.toHaveProperty('pending_tool_calls');
    expect(body.result.pending_tool_calls[0].input).toEqual({});
    const full = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 100, preset: 'full' });
    const fullBody = JSON.parse(full.chunks.join('')); full.restore();
    expect(fullBody.result.pending_tool_calls[0].input).toEqual(input);
  });
  it('returns changed for a same-size pending-input rewrite', async () => {
    const pending: NormalizedMessage = { ...makeMessage(3), role: 'tool_use', content: 'Tool: Write', blocks: [{ type: 'tool_use', id: 'write', name: 'Write', input: { content: 'AAAA' } }] };
    const session = makeSession([makeMessage(1), makeMessage(2), pending]);
    vi.mocked(loadSession).mockResolvedValue(session);
    const first = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'tail' });
    const original = JSON.parse(first.chunks.join('')); first.restore();
    (pending.blocks[0] as { input: Record<string, unknown> }).input.content = 'BBBB';
    const second = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'tail', ifChanged: original.meta.etag });
    const changed = JSON.parse(second.chunks.join('')); second.restore();
    expect(changed.result.unchanged).not.toBe(true);
    expect(changed.meta.etag).not.toBe(original.meta.etag);
    expect(changed.result.pending_tool_calls[0].input.content).toBe('BBBB');
  });
  it.each([false, true])('emits canonical whole-session pending calls (batch=%s)', async (batch) => {
    const pending: NormalizedMessage = { ...makeMessage(3), role: 'tool_use', content: 'Tool: AskUserQuestion', blocks: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { question: 'Proceed?' } }] };
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1), makeMessage(2), pending]));
    const out = captureStdout();
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'tail', ...(batch ? { batch: 'ids.txt' } : {}) });
    const text = out.chunks.join(''); out.restore();
    const body = batch ? JSON.parse(text.trim().split('\n').at(-1)!) : JSON.parse(text);
    expect(body.result.pending_tool_calls).toHaveLength(1);
    expect(body.result.pending_tool_calls[0]).toMatchObject({ index: 3, tool_use_id: 'ask', name: 'AskUserQuestion' });
    expect(body.meta).not.toHaveProperty('pendingToolCalls');
    expect(body.result.pending_tool_calls[0]).not.toHaveProperty('messageIndex');
  });
});
