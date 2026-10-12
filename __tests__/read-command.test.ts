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
