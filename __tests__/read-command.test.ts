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
