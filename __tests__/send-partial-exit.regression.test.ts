import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * wp/06 regression — `sessionr send --new` must NOT exit 0 when the new
 * session cannot be detected.
 *
 * Before the fix, `runSync` returned `{ status: 'completed', exit_code: 0 }`
 * with a friendly "could not be detected" message. The agent saw `completed`,
 * tried to read --after 0 from a `null` session_id, and either crashed or
 * (worse) re-sent the prompt and created another orphan session.
 *
 * Required behavior:
 *   - throws SessionReaderError({
 *       code: 'NEW_SESSION_NOT_DETECTED',
 *       class: 'partial',
 *       exitCode: EXIT.PARTIAL (10),
 *       retry: true,
 *       suggestion: includes "sessionr list --cwd current --source <source>",
 *     })
 *   - the global try/catch in sendCommand routes the error through
 *     emit(failure(...)) so JSON callers get the v2 envelope on stdout.
 *   - process.exitCode is set to 10 (EXIT.PARTIAL).
 */

// ── Test doubles ────────────────────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
  readonly pid = 12_345;
  readonly stdout: EventEmitter & { on: EventEmitter['on'] };
  readonly stderr: EventEmitter & { on: EventEmitter['on'] };
  killed = false;

  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  unref(): this {
    return this;
  }
}

function captureIO(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      stdout.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => {
      stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write);
  return {
    stdout,
    stderr,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('../src/discovery.js');
  vi.resetModules();
});

describe('send --new exits PARTIAL when new session cannot be detected (wp/06)', () => {
  let io: ReturnType<typeof captureIO>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    io = captureIO();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    io.restore();
    process.exitCode = originalExitCode;
  });

  async function loadSendWithStubs(): Promise<typeof import('../src/commands/send.js')> {
    vi.resetModules();

    // Stub the spawn boundary so spawnAndWait sees a tool that exits 0
    // immediately. The child's stdout/stderr emitters fire no data and we
    // emit 'close' on next-tick to settle the spawnAndWait promise.
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          const child = new FakeChildProcess();
          setImmediate(() => child.emit('close', 0));
          return child as unknown as ReturnType<typeof actual.spawn>;
        }),
      };
    });

    // Stub discovery so listSessions returns no candidates → detectNewSession
    // exhausts its polling attempts and returns null.
    vi.doMock('../src/discovery.js', () => ({
      loadSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    }));

    return import('../src/commands/send.js');
  }

  it('throws NEW_SESSION_NOT_DETECTED with class=partial and exitCode=10', async () => {
    const { sendCommand } = await loadSendWithStubs();

    await sendCommand(undefined, {
      output: 'json',
      new: true,
      source: 'claude',
      message: 'hello',
      cwd: '/tmp/nowhere-no-sessions',
    });

    expect(io.stdout.length).toBeGreaterThan(0);
    const envelope = JSON.parse(io.stdout.join(''));

    expect(envelope.ok).toBe(false);
    expect(envelope.schema_version).toBe('v2');
    expect(envelope.error.code).toBe('NEW_SESSION_NOT_DETECTED');
    expect(envelope.error.class).toBe('partial');
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.suggestion).toContain('sessionr list --cwd current --source claude');

    // exitCode 10 = EXIT.PARTIAL. The whole point of the fix.
    expect(process.exitCode).toBe(10);
  }, 30_000);

  it('error detail carries the source and cwd so agents can target a list call', async () => {
    const { sendCommand } = await loadSendWithStubs();

    await sendCommand(undefined, {
      output: 'json',
      new: true,
      source: 'claude',
      message: 'hello',
      cwd: '/tmp/nowhere-no-sessions',
    });

    const envelope = JSON.parse(io.stdout.join(''));
    expect(envelope.error.detail).toMatchObject({
      source: 'claude',
      cwd: '/tmp/nowhere-no-sessions',
    });
    // Hint about the flush race lives in detail so it's surfaced to agents
    // without bloating the message.
    expect(typeof envelope.error.detail.hint).toBe('string');
  }, 30_000);

  it('detectNewSession returning null is exactly the trigger (unit-level coverage)', async () => {
    // Locks the contract independently of the send pipeline: when
    // listSessions returns no fresh candidates, detectNewSession resolves to
    // `null` so the runSync caller hits the throw branch.
    const { detectNewSession } = await import('../src/commands/send.js');
    const listSessions = vi.fn().mockResolvedValue([]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await detectNewSession('claude', '/repo', Date.now(), {
      listSessions: listSessions as never,
      sleep,
    });

    expect(result).toBeNull();
  });
});

describe('send.ts source still throws NEW_SESSION_NOT_DETECTED (compile-locked grep)', () => {
  // Cheap textual proof that the throw is still present in the source. This
  // is the same probe Agent C is asked to run in the acceptance checklist; we
  // codify it so a future refactor can't silently delete the branch.
  it('the send.ts source still throws NEW_SESSION_NOT_DETECTED on null detect', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/commands/send.ts', 'utf-8');
    expect(src).toMatch(/code:\s*['"]NEW_SESSION_NOT_DETECTED['"]/);
    expect(src).toMatch(/errorClass:\s*['"]partial['"]/);
    expect(src).toMatch(/EXIT\.PARTIAL/);
  });
});
