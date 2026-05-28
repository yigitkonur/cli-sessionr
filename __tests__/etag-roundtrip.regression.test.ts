// it/01 + it/02 regression — etag is emitted in a normal read response and
// the same etag fed back via --if-changed short-circuits with a v2 envelope
// and EXIT.NO_CHANGES (42). Without both halves the polling primitive is
// unreachable for agents.

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
    id: 'sess-etag',
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

// Capture every chunk written to process.stdout / process.stderr. Agent A's
// read.ts migration uses emit() (process.stdout.write) instead of console.log,
// so we spy on the lower-level write surface and rebuild the full payload
// before asserting.
function makeStdoutCapture(): { write: ReturnType<typeof vi.spyOn>; payload: () => string } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'));
    return true;
  });
  return { write: spy, payload: () => chunks.join('') };
}

describe('etag roundtrip (it/01 + it/02 + it/03)', () => {
  let stdout: { write: ReturnType<typeof vi.spyOn>; payload: () => string };
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    stdout = makeStdoutCapture();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(loadSession).mockResolvedValue(
      makeSession(Array.from({ length: 6 }, (_, i) => makeMessage(i + 1))),
    );
  });

  afterEach(() => {
    stdout.write.mockRestore();
    stderrSpy?.mockRestore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  function parseEnvelope(): Record<string, unknown> {
    const raw = stdout.payload().trim();
    return JSON.parse(raw);
  }

  it('it/01: a normal read response includes meta.etag (16-char hex)', async () => {
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000 });

    const body = parseEnvelope();
    const meta = body.meta as { etag?: string };
    expect(meta.etag).toBeDefined();
    expect(meta.etag).toMatch(/^[0-9a-f]{16}$/);
  });

  it('it/01+02: same params + --if-changed <etag> short-circuits with v2 envelope and EXIT.NO_CHANGES', async () => {
    // First call: capture etag.
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000 });
    const first = parseEnvelope();
    const etag = (first.meta as { etag: string }).etag;
    expect(etag).toMatch(/^[0-9a-f]{16}$/);

    stdout.write.mockRestore();
    stdout = makeStdoutCapture();
    process.exitCode = undefined;

    // Second call: feed etag back via --if-changed.
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000, ifChanged: etag });

    expect(process.exitCode).toBe(EXIT.NO_CHANGES);
    const unchanged = parseEnvelope() as {
      ok: boolean;
      schema_version: string;
      result: Record<string, unknown>;
      meta?: Record<string, unknown>;
      actions?: Array<{ command: string }>;
    };

    // it/02: v2 envelope shape.
    expect(unchanged.ok).toBe(true);
    expect(unchanged.schema_version).toBe('v2');
    expect(unchanged.result.unchanged).toBe(true);
    expect(unchanged.result.etag).toBe(etag);
    expect(unchanged.result.session_id).toBe('sess-etag');
    expect(unchanged.result.source).toBe('codex');
    expect(unchanged.result.total_messages).toBe(6);
    expect(unchanged.result.updated_at).toBeDefined();
    expect((unchanged.meta as { etag: string }).etag).toBe(etag);
    expect(Array.isArray(unchanged.actions)).toBe(true);
    expect(unchanged.actions!.length).toBeGreaterThanOrEqual(2);
    const cmds = unchanged.actions!.map((a) => a.command);
    expect(cmds.some((c) => c.includes('--if-changed'))).toBe(true);
  });

  it('it/03: different --preset produces a different etag (no false short-circuit)', async () => {
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000, preset: 'minimal' });
    const minimal = (parseEnvelope().meta as { etag: string }).etag;

    stdout.write.mockRestore();
    stdout = makeStdoutCapture();

    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000, preset: 'verbose' });
    const verbose = (parseEnvelope().meta as { etag: string }).etag;

    expect(minimal).toBeDefined();
    expect(verbose).toBeDefined();
    expect(minimal).not.toBe(verbose);

    // And: polling for `verbose` while holding `minimal`-etag must NOT
    // short-circuit (cli is supposed to fetch the new view).
    stdout.write.mockRestore();
    stdout = makeStdoutCapture();
    process.exitCode = undefined;
    await readCommand('sess-etag', undefined, undefined, {
      output: 'json',
      tokens: 4000,
      preset: 'verbose',
      ifChanged: minimal,
    });
    // No NO_CHANGES exit — the etag for the verbose view differs.
    expect(process.exitCode).not.toBe(EXIT.NO_CHANGES);
    const body = parseEnvelope();
    expect((body.meta as { etag: string }).etag).toBe(verbose);
  });

  it('it/03: different --tokens produces a different etag', async () => {
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 1000 });
    const small = (parseEnvelope().meta as { etag: string }).etag;

    stdout.write.mockRestore();
    stdout = makeStdoutCapture();

    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 8000 });
    const large = (parseEnvelope().meta as { etag: string }).etag;

    expect(small).not.toBe(large);
  });

  it('it/01: --page path also includes meta.etag', async () => {
    await readCommand('sess-etag', undefined, undefined, { output: 'json', tokens: 4000, page: 1 });
    const body = parseEnvelope();
    expect((body.meta as { etag: string }).etag).toMatch(/^[0-9a-f]{16}$/);
  });
});
