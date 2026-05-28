/**
 * Phase 3 regression coverage for ds/02 send --dry-run + --max-new-per-run
 * and ds/03 --detect-timeout-ms.
 *
 * Each test stubs the discovery layer (so we never touch real session
 * dirs) and the child_process layer (so a failure to short-circuit on
 * --dry-run is detected as a spawn call we then assert was never made).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error(
      'send-dry-run regression: spawn() must NOT be called during --dry-run',
    );
  }),
}));

vi.mock('../src/discovery.js', () => ({
  loadSession: vi.fn(),
  listSessions: vi.fn(),
}));

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

function parseEnvelope(chunks: string[]): Record<string, unknown> {
  return JSON.parse(chunks.join(''));
}

describe('ds/02 — send --dry-run never spawns a child', () => {
  let io: ReturnType<typeof captureStdout>;
  let sendCommand: typeof import('../src/commands/send.js')['sendCommand'];
  let spawnMock: ReturnType<typeof vi.fn>;
  let loadSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.exitCode = undefined;
    io = captureStdout();
    const cp = await import('node:child_process');
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockClear();
    const discovery = await import('../src/discovery.js');
    loadSessionMock = discovery.loadSession as unknown as ReturnType<typeof vi.fn>;
    loadSessionMock.mockClear();
    ({ sendCommand } = await import('../src/commands/send.js'));
  });

  afterEach(() => {
    io.restore();
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('--dry-run + --new emits a v2 success envelope with would_spawn (no spawn call)', async () => {
    await sendCommand(undefined, {
      message: 'hi from dry-run',
      source: 'claude',
      new: true,
      output: 'json',
      // @ts-expect-error — Phase 3 extension fields (kept local to send.ts)
      dryRun: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe('v2');
    const result = env.result as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.is_new_session).toBe(true);
    expect(result.source).toBe('claude');
    const wouldSpawn = result.would_spawn as Record<string, unknown>;
    expect(wouldSpawn.bin).toBe('claude');
    expect(Array.isArray(wouldSpawn.args)).toBe(true);
    expect(typeof wouldSpawn.cwd).toBe('string');
  });

  it('--dry-run for resume loads the session metadata but still does NOT spawn', async () => {
    loadSessionMock.mockResolvedValue({
      id: 'abc123',
      source: 'codex',
      messages: [],
      stats: { totalMessages: 5, byRole: { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 } },
      metadata: { cwd: '/tmp', model: 'unknown' },
    });

    await sendCommand('abc123', {
      message: 'follow up',
      output: 'json',
      // @ts-expect-error — Phase 3 extension fields
      dryRun: true,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(true);
    const result = env.result as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.session_id).toBe('abc123');
    const wouldSpawn = result.would_spawn as Record<string, unknown>;
    expect(wouldSpawn.bin).toBe('codex');
    expect((wouldSpawn.args as string[]).join(' ')).toContain('abc123');
  });

  it('--max-new-per-run 0 refuses --new with MAX_NEW_EXCEEDED', async () => {
    await sendCommand(undefined, {
      message: 'should not spawn',
      source: 'claude',
      new: true,
      output: 'json',
      // @ts-expect-error — Phase 3 extension fields
      maxNewPerRun: 0,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(false);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe('MAX_NEW_EXCEEDED');
    expect(error.class).toBe('validation');
    expect(process.exitCode).toBe(2);
  });

  it('--max-new-per-run does NOT block a resume (resume is not a new session)', async () => {
    loadSessionMock.mockResolvedValue({
      id: 'sess-resume',
      source: 'codex',
      messages: [],
      stats: { totalMessages: 1, byRole: { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 } },
      metadata: { cwd: '/tmp', model: 'unknown' },
    });

    await sendCommand('sess-resume', {
      message: 'resume me',
      output: 'json',
      // @ts-expect-error — Phase 3 extension fields
      dryRun: true,
      maxNewPerRun: 0,
    });

    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(true);
    expect((env.result as Record<string, unknown>).dry_run).toBe(true);
  });
});

describe('ds/03 — detect-timeout-ms is configurable', () => {
  // Avoid the spawn mock's hard error by skipping resume loadSession path.
  // We only exercise the detectNewSession helper directly.
  it('detectNewSession honours a custom timeoutMs', async () => {
    vi.resetModules();
    const send = await import('../src/commands/send.js');

    const t0 = Date.now();
    // No fresh sessions for cwd; expect null after polling completes.
    const result = await send.detectNewSession('claude', '/does/not/exist', t0, {
      listSessions: async () => [],
      sleep: async () => undefined,
      timeoutMs: 5_000,
    });
    expect(result).toBeNull();
  });

  it('detectNewSession returns the freshest matching session', async () => {
    vi.resetModules();
    const send = await import('../src/commands/send.js');
    const cwd = '/tmp/proj';
    const beforeSendT = Date.now() - 1000; // session must be >= beforeSendT - slop
    const fresh = {
      id: 'fresh-session',
      cwd,
      source: 'claude' as const,
      updatedAt: new Date(),
      filePath: '/tmp/fresh.jsonl',
    };

    const result = await send.detectNewSession('claude', cwd, beforeSendT, {
      listSessions: async () => [fresh],
      sleep: async () => undefined,
      timeoutMs: 2_000,
    });
    expect(result).toBe('fresh-session');
  });
});
