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
