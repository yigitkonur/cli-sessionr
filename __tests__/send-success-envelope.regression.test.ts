import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v3 final-review regression: `send` SUCCESS paths must emit the canonical v2
 * envelope ({ok, schema_version, result, ...}) via emit() — NOT the old
 * {api_version:1, meta, messages} (runSync) or {api_version:1, data:{…}}
 * (runAsync) shapes that were written directly via console.log.
 *
 * This gap survived 365 tests because the success terminal only runs AFTER a
 * real child agent spawns; the existing suite covered only the error /
 * validation / dry-run branches. We mock the spawn + job boundaries so the
 * success path runs deterministically without launching anything.
 */

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  unref(): this { return this; }
}

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    stdout.push(typeof c === 'string' ? c : String(c)); return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
    stderr.push(typeof c === 'string' ? c : String(c)); return true;
  }) as typeof process.stderr.write);
  return { stdout, stderr, restore: () => { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); } };
}

const FAKE_SESSION = {
  id: 'sess-success-1',
  source: 'claude' as const,
  filePath: '/tmp/sess-success-1.jsonl',
  metadata: {
    cwd: '/tmp', model: 'claude-opus-4-7',
    createdAt: new Date('2026-05-27T00:00:00Z'),
    updatedAt: new Date('2026-05-27T01:00:00Z'),
    fileBytes: 10, rawLineCount: 2,
  },
  messages: [
    { index: 1, role: 'user' as const, timestamp: new Date('2026-05-27T00:00:00Z'), content: 'hi', blocks: [{ type: 'text' as const, text: 'hi' }] },
    { index: 2, role: 'assistant' as const, timestamp: new Date('2026-05-27T00:01:00Z'), content: 'hello', blocks: [{ type: 'text' as const, text: 'hello' }] },
  ],
  stats: {
    totalMessages: 2,
    byRole: { user: 1, assistant: 1, system: 0, toolUse: 0, toolResult: 0 },
    byBlockType: { text: 2 },
    toolFrequency: [], filesModified: [], durationMs: 60000,
  },
};

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/discovery.js');
  vi.doUnmock('../src/jobs.js');
  vi.resetModules();
});

describe('send async success → v2 envelope, no `data` wrapper (oc/07+08)', () => {
  let io: ReturnType<typeof captureIO>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => { io = captureIO(); originalExitCode = process.exitCode; process.exitCode = undefined; });
  afterEach(() => { io.restore(); process.exitCode = originalExitCode; });

  async function loadStubbed() {
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: vi.fn(() => new FakeChildProcess() as unknown as ReturnType<typeof actual.spawn>) };
    });
    vi.doMock('../src/discovery.js', () => ({
      loadSession: vi.fn().mockResolvedValue(FAKE_SESSION),
      listSessions: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/jobs.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/jobs.js')>();
      return {
        ...actual,
        createJob: vi.fn((args: { id: string; sessionId: string | null; source: string }) => ({
          id: args.id, session_id: args.sessionId, source: args.source,
          status: 'running', pid: 4242, started_at: '2026-05-27T02:00:00.000Z',
          read_back: { source: args.source }, cwd: '/tmp', message: 'hi',
          exit_code: null, completed_at: null, message_count_before: 2,
          stdout_file: '/tmp/j.stdout', stderr_file: '/tmp/j.stderr', is_new_session: false,
        })),
      };
    });
    return import('../src/commands/send.js');
  }

  it('emits {ok, schema_version:v2, result:{job_id,...}} with NO data wrapper and NO api_version', async () => {
    const { sendCommand } = await loadStubbed();
    await sendCommand('sess-success-1', { output: 'json', async: true, message: 'hi', source: 'claude' });

    expect(io.stdout.length).toBeGreaterThan(0);
    const env = JSON.parse(io.stdout.join(''));
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe('v2');
    expect(env).not.toHaveProperty('data');       // the old wrapper is gone
    expect(env).not.toHaveProperty('api_version'); // the old field is gone
    expect(env.result.job_id).toBeTruthy();
    expect(env.result.status).toBe('running');
    expect(env.result.session_id).toBe('sess-success-1');
    expect(Array.isArray(env.actions)).toBe(true);
  }, 30_000);
});

describe('send.ts source guard — no console.log envelope leaks', () => {
  it('runSync/runAsync no longer console.log an api_version/data envelope', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/commands/send.ts', 'utf-8');
    // The only console.log allowed would be none — success paths go through emit().
    expect(src).not.toMatch(/console\.log\(JSON\.stringify\(envelope/);
    expect(src).not.toMatch(/api_version:\s*1/);
    // Both success terminals must use the v2 helper.
    expect(src).toMatch(/emit\(success\(sendResult/);
    expect(src).toMatch(/emit\(success\(result/);
  });
});
