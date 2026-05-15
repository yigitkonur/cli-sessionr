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

describe('readCommand validation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadSession).mockResolvedValue(makeSession([makeMessage(1), makeMessage(2)]));
  });

  afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('returns INVALID_TOKEN_BUDGET for non-positive tokens', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 0 });

    const body = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(body.error.code).toBe('INVALID_TOKEN_BUDGET');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('returns INVALID_ROLE for unknown roles before slicing', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', role: 'user,banana' });

    const body = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(body.error.code).toBe('INVALID_ROLE');
    expect(body.error.detail.unknown).toEqual(['banana']);
    expect(body.error.detail.valid).toEqual(['user', 'assistant', 'system', 'tool_use', 'tool_result']);
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('returns INVALID_ANCHOR for unknown anchors', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'sideways' });

    const body = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(body.error.code).toBe('INVALID_ANCHOR');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('requires --search with --anchor search', async () => {
    await readCommand('sess-test', undefined, undefined, { output: 'json', anchor: 'search' });

    const body = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(body.error.code).toBe('INVALID_ANCHOR_USAGE');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('marks truncated token slices as partial and exits PARTIAL', async () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      makeMessage(i + 1, `message ${i + 1} ${'x'.repeat(100)}`),
    );
    vi.mocked(loadSession).mockResolvedValue(makeSession(messages));

    await readCommand('sess-test', undefined, undefined, { output: 'json', tokens: 200 });

    const body = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(body.meta.partial).toBe(true);
    expect(body.meta.has_more_after || body.meta.has_more_before).toBe(true);
    expect(process.exitCode).toBe(EXIT.PARTIAL);
  });
});
