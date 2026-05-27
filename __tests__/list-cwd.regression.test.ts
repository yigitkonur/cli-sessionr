/**
 * Regression for cwd-aware/01 (CRITICAL): `sessionr list` must surface
 * `meta.cwd_scope` so callers can tell whether they got the auto-scoped
 * slice, the global fallback, the `all` set, or an explicit-path filter.
 *
 * We mock the discovery layer's `listSessionsScoped` so we can drive each
 * scope branch without touching the real filesystem, then assert the v2
 * envelope written to stdout has the right `meta.cwd_scope` value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCommand } from '../src/commands/list.js';
import { listSessionsScoped } from '../src/discovery.js';
import type { SessionListEntry } from '../src/types.js';
import type { ScopedListSessionsResult } from '../src/discovery.js';

vi.mock('../src/discovery.js', () => ({
  listSessionsScoped: vi.fn(),
  loadSession: vi.fn(),
}));

function makeEntry(id: string, cwd: string): SessionListEntry {
  return {
    id,
    source: 'codex',
    cwd,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    filePath: `/tmp/${id}.jsonl`,
  };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

function parseLast(chunks: string[]): Record<string, unknown> {
  const joined = chunks.join('');
  return JSON.parse(joined);
}

describe('listCommand cwd-aware envelope (regression: cwd-aware/01)', () => {
  let io: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    process.exitCode = undefined;
    io = captureStdout();
  });

  afterEach(() => {
    io.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('surfaces cwd_scope:"auto" with the matching subset when cwd matches', async () => {
    const matching: ScopedListSessionsResult = {
      sessions: [
        makeEntry('s1', '/work/proj'),
        makeEntry('s2', '/work/proj'),
      ],
      meta: { cwd_scope: 'auto', cwd: '/work/proj' },
    };
    vi.mocked(listSessionsScoped).mockResolvedValue(matching);

    await listCommand(undefined, { output: 'json' });

    expect(listSessionsScoped).toHaveBeenCalledWith(undefined, 'auto');
    const env = parseLast(io.chunks);
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe('v2');
    expect((env.meta as Record<string, unknown>).cwd_scope).toBe('auto');
    expect((env.meta as Record<string, unknown>).cwd).toBe('/work/proj');
    const result = env.result as { sessions: unknown[]; total_available: number };
    expect(result.sessions.length).toBe(2);
    expect(result.total_available).toBe(2);
  });

  it('surfaces cwd_scope:"fellback_to_global" when no sessions matched current cwd', async () => {
    const fallback: ScopedListSessionsResult = {
      sessions: [
        makeEntry('g1', '/elsewhere'),
        makeEntry('g2', '/elsewhere'),
        makeEntry('g3', '/elsewhere'),
      ],
      meta: {
        cwd_scope: 'fellback_to_global',
        cwd: '/empty/dir',
        reason: 'no sessions matched cwd',
      },
    };
    vi.mocked(listSessionsScoped).mockResolvedValue(fallback);

    await listCommand(undefined, { output: 'json' });

    const env = parseLast(io.chunks);
    expect(env.ok).toBe(true);
    expect((env.meta as Record<string, unknown>).cwd_scope).toBe('fellback_to_global');
    expect((env.meta as Record<string, unknown>).cwd).toBe('/empty/dir');
    expect((env.meta as Record<string, unknown>).cwd_scope_reason).toBe('no sessions matched cwd');
    const result = env.result as { sessions: unknown[] };
    expect(result.sessions.length).toBe(3);
  });

  it('surfaces cwd_scope:"all" when --cwd all is passed', async () => {
    const all: ScopedListSessionsResult = {
      sessions: [
        makeEntry('a1', '/proj/one'),
        makeEntry('a2', '/proj/two'),
        makeEntry('a3', '/proj/three'),
      ],
      meta: { cwd_scope: 'all', cwd: '/cwd/at/invocation' },
    };
    vi.mocked(listSessionsScoped).mockResolvedValue(all);

    await listCommand(undefined, { output: 'json', cwd: 'all' });

    expect(listSessionsScoped).toHaveBeenCalledWith(undefined, 'all');
    const env = parseLast(io.chunks);
    expect((env.meta as Record<string, unknown>).cwd_scope).toBe('all');
    const result = env.result as { sessions: unknown[] };
    expect(result.sessions.length).toBe(3);
  });

  it('surfaces cwd_scope:"explicit" when --cwd <path> is passed', async () => {
    const explicit: ScopedListSessionsResult = {
      sessions: [makeEntry('e1', '/explicit/path')],
      meta: { cwd_scope: 'explicit', cwd: '/explicit/path' },
    };
    vi.mocked(listSessionsScoped).mockResolvedValue(explicit);

    await listCommand(undefined, { output: 'json', cwd: '/explicit/path' });

    expect(listSessionsScoped).toHaveBeenCalledWith(undefined, '/explicit/path');
    const env = parseLast(io.chunks);
    expect((env.meta as Record<string, unknown>).cwd_scope).toBe('explicit');
    expect((env.meta as Record<string, unknown>).cwd).toBe('/explicit/path');
    const result = env.result as { sessions: unknown[] };
    expect(result.sessions.length).toBe(1);
  });

  it('defaults to "auto" mode when --cwd is omitted', async () => {
    vi.mocked(listSessionsScoped).mockResolvedValue({
      sessions: [],
      meta: {
        cwd_scope: 'fellback_to_global',
        cwd: process.cwd(),
        reason: 'no sessions matched cwd',
      },
    });

    await listCommand(undefined, { output: 'json' });

    expect(listSessionsScoped).toHaveBeenCalledWith(undefined, 'auto');
  });
});
