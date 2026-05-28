import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for the four Phase-1 send/runner critical bugs.
// Each describe() block corresponds to a bug file in agentic-issues/.

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

// ── Bug 1: oc/05 — send validation must route through the formatter ─────────

describe('send validation routes through v2 envelope (oc/05)', () => {
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

  it('emits MISSING_MESSAGE as a v2 failure envelope on stdout', async () => {
    const { sendCommand } = await import('../src/commands/send.js');
    await sendCommand(undefined, { output: 'json' });

    expect(io.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(io.stdout.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe('v2');
    expect(parsed.error.class).toBe('validation');
    expect(parsed.error.code).toBe('MISSING_MESSAGE');
    expect(parsed.error.retryable).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it('emits CONFLICTING_FLAGS when both --message and --file are supplied', async () => {
    const { sendCommand } = await import('../src/commands/send.js');
    await sendCommand('abc', { output: 'json', message: 'hi', file: '/tmp/x.md' });

    const parsed = JSON.parse(io.stdout.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.class).toBe('validation');
    expect(parsed.error.code).toBe('CONFLICTING_FLAGS');
    expect(process.exitCode).toBe(2);
  });

  it('emits FILE_NOT_READABLE when --file points at a missing path', async () => {
    const { sendCommand } = await import('../src/commands/send.js');
    await sendCommand('abc', {
      output: 'json',
      file: '/tmp/definitely-not-here-sessionr-regression',
    });

    const parsed = JSON.parse(io.stdout.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.class).toBe('validation');
    expect(parsed.error.code).toBe('FILE_NOT_READABLE');
    expect(parsed.error.detail.path).toContain('definitely-not-here');
    expect(process.exitCode).toBe(2);
  });

  it('writes the envelope to STDOUT (not stderr) in JSON mode — oc/04 rule', async () => {
    const { sendCommand } = await import('../src/commands/send.js');
    await sendCommand(undefined, { output: 'json' });

    // Validation errors must NOT bypass the formatter onto stderr anymore.
    expect(io.stderr.join('')).not.toContain('Error: Either --message');
    expect(io.stdout.length).toBeGreaterThan(0);
  });
});

// ── Bug 2: wp/01 — deadbeef session must not crash, must surface v2 envelope ──

describe('send with unresolved spawn command (wp/01)', () => {
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

  it('runners.buildResumeCommand throws SOURCE_UNKNOWN instead of returning undefined', async () => {
    const { buildResumeCommand } = await import('../src/runners.js');
    const { SessionReaderError } = await import('../src/errors.js');

    expect(() => buildResumeCommand(undefined, 'deadbeef', 'hi')).toThrow(SessionReaderError);
    try {
      buildResumeCommand(undefined, 'deadbeef', 'hi');
    } catch (err) {
      const sre = err as InstanceType<typeof SessionReaderError>;
      expect(sre.code).toBe('SOURCE_UNKNOWN');
      // Even before Phase 2 sweeps subclass defaults, this builder sets class
      // explicitly so the v2 envelope renders as not_found, not internal.
      expect(sre.class).toBe('not_found');
    }
  });

  it('runners.buildNewCommand throws SOURCE_UNKNOWN instead of returning undefined', async () => {
    const { buildNewCommand } = await import('../src/runners.js');
    const { SessionReaderError } = await import('../src/errors.js');

    try {
      buildNewCommand(undefined, 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as InstanceType<typeof SessionReaderError>).code).toBe('SOURCE_UNKNOWN');
    }
  });

  it('sendCommand surfaces SESSION_NOT_FOUND (no TypeError) when the id has no match', async () => {
    // discovery.loadSession throws SessionNotFoundError; sendCommand must
    // catch it and emit a v2 failure envelope — never crash on undefined.bin.
    const { sendCommand } = await import('../src/commands/send.js');
    await sendCommand('this-id-does-not-exist-anywhere-1234567890', {
      output: 'json',
      message: 'hi',
    });

    const parsed = JSON.parse(io.stdout.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe('v2');
    // Either SESSION_NOT_FOUND or NEW_SESSION_NOT_DETECTED — both acceptable.
    // The point is "no TypeError, structured error envelope".
    expect(typeof parsed.error.code).toBe('string');
    expect(parsed.error.code).not.toBe('UNKNOWN_ERROR');
    expect(typeof parsed.error.message).toBe('string');
    expect(parsed.error.message).not.toContain("undefined");
    expect(parsed.error.message).not.toContain('Cannot read properties');
  }, 30_000);
});

// ── Bug 3: wp/02 — detectNewSession must use a before_send_t cutoff ─────────

describe('detectNewSession uses before_send_t cutoff (wp/02)', () => {
  it('returns only sessions whose updatedAt is >= before_send_t (minus slop)', async () => {
    const { detectNewSession } = await import('../src/commands/send.js');

    // Anchor at "now" so the freshness window (t - updatedAt < 30_000)
    // also passes. The cutoff guard is the load-bearing condition under test.
    const beforeSendT = Date.now();
    const cwd = '/repo/proj';
    const stale = {
      id: 'old-session-from-different-tool',
      source: 'claude' as const,
      cwd,
      // 10s before beforeSendT — older than the 2s slop window.
      updatedAt: new Date(beforeSendT - 10_000),
      filePath: '/tmp/stale.jsonl',
    };
    const fresh = {
      id: 'fresh-session-just-created',
      source: 'claude' as const,
      cwd,
      // 50ms after spawn started — clearly the new session.
      updatedAt: new Date(beforeSendT + 50),
      filePath: '/tmp/fresh.jsonl',
    };

    const fakeList = vi.fn().mockResolvedValue([stale, fresh]);
    const fakeSleep = vi.fn().mockResolvedValue(undefined);

    const result = await detectNewSession('claude', cwd, beforeSendT, {
      listSessions: fakeList as never,
      sleep: fakeSleep,
    });

    expect(result).toBe('fresh-session-just-created');
    // Must not have returned the unrelated older session even though it would
    // have matched the cwd filter under the old logic.
    expect(result).not.toBe('old-session-from-different-tool');
  });

  it('returns null when no candidate clears the cutoff (NEW_SESSION_NOT_DETECTED upstream)', async () => {
    const { detectNewSession } = await import('../src/commands/send.js');

    const beforeSendT = Date.now();
    const onlyStale = [
      {
        id: 'too-old',
        source: 'claude' as const,
        cwd: '/repo',
        updatedAt: new Date(beforeSendT - 60_000),
        filePath: '/tmp/old.jsonl',
      },
    ];

    const fakeList = vi.fn().mockResolvedValue(onlyStale);
    const fakeSleep = vi.fn().mockResolvedValue(undefined);

    const result = await detectNewSession('claude', '/repo', beforeSendT, {
      listSessions: fakeList as never,
      sleep: fakeSleep,
    });

    expect(result).toBeNull();
  });

  it('picks the candidate closest to spawn-completion time when multiple match', async () => {
    const { detectNewSession } = await import('../src/commands/send.js');

    const beforeSendT = Date.now() - 100;
    const cwd = '/repo';
    // Two fresh candidates; the one updated MOST recently should win because
    // it is closest to "now" (spawn-completion time).
    const earlier = {
      id: 'fresh-but-earlier',
      source: 'claude' as const,
      cwd,
      updatedAt: new Date(beforeSendT + 10),
      filePath: '/tmp/a.jsonl',
    };
    const later = {
      id: 'fresh-and-latest',
      source: 'claude' as const,
      cwd,
      updatedAt: new Date(),
      filePath: '/tmp/b.jsonl',
    };

    const fakeList = vi.fn().mockResolvedValue([earlier, later]);
    const fakeSleep = vi.fn().mockResolvedValue(undefined);

    const result = await detectNewSession('claude', cwd, beforeSendT, {
      listSessions: fakeList as never,
      sleep: fakeSleep,
    });

    expect(result).toBe('fresh-and-latest');
  });
});

// ── Bug 4: wp/03 — spawn stdio pipes must be drained on data + close ────────

describe('spawnAndWait drains stdio pipes (wp/03)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('tapOutput captures data chunks and flushes trailing buffer on close', async () => {
    const { tapOutput } = await import('../src/commands/send.js');

    const stream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const tap = tapOutput(stream);

    stream.emit('data', Buffer.from('line-one\nline-two\nparti'));
    expect(tap.lines).toEqual(['line-one', 'line-two']);

    stream.emit('data', Buffer.from('al-line\n'));
    expect(tap.lines).toEqual(['line-one', 'line-two', 'partial-line']);

    stream.emit('data', Buffer.from('no-trailing-newline'));
    // Still buffered — not promoted to a line yet.
    expect(tap.lines).toEqual(['line-one', 'line-two', 'partial-line']);

    // close-time flush must promote the residual buffer so callers don't lose
    // the final chunk (wp/03 regression).
    tap.flush();
    expect(tap.lines).toEqual([
      'line-one',
      'line-two',
      'partial-line',
      'no-trailing-newline',
    ]);
  });

  it('spawnAndWait collects both stdout and stderr through the tap', async () => {
    const { spawnAndWait } = await import('../src/commands/send.js');

    const script =
      'process.stdout.write("out-1\\nout-2\\n"); process.stderr.write("err-1\\n"); process.exit(0);';
    const result = await spawnAndWait(
      { bin: process.execPath, args: ['-e', script] },
      process.cwd(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toContain('out-1');
    expect(result.stdoutTail).toContain('out-2');
    expect(result.stderrTail).toContain('err-1');
  });

  it('tap drains trailing data emitted just before close (no lost final chunk)', async () => {
    const { tapOutput } = await import('../src/commands/send.js');

    const stream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    const tap = tapOutput(stream);

    // Simulate a child that wrote a line without a trailing newline right
    // before exiting. flush() (called from the 'close' handler in
    // spawnAndWait) must surface it.
    stream.emit('data', Buffer.from('final-without-newline'));
    expect(tap.lines).toHaveLength(0);

    tap.flush();
    expect(tap.lines).toEqual(['final-without-newline']);
  });
});
