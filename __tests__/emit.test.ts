import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emit, markStart } from '../src/output/emit.js';
import { success, failure } from '../src/output/envelope.js';

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

describe('emit()', () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
  });

  afterEach(() => {
    io.restore();
  });

  it('writes a success envelope as JSON to stdout', () => {
    emit(success({ hello: 'world' }));
    expect(io.stderr).toEqual([]);
    expect(io.stdout.length).toBe(1);
    const parsed = JSON.parse(io.stdout[0]);
    expect(parsed).toEqual({
      ok: true,
      schema_version: 'v2',
      result: { hello: 'world' },
    });
  });

  it('writes a failure envelope to STDOUT (not stderr) in JSON mode — oc/04 fix', () => {
    emit(
      failure({
        class: 'not_found',
        code: 'SESSION_NOT_FOUND',
        message: 'gone',
        retryable: false,
      }),
    );
    expect(io.stderr).toEqual([]);
    expect(io.stdout.length).toBe(1);
    const parsed = JSON.parse(io.stdout[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe('v2');
    expect(parsed.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('injects meta.timing_ms (integer >= 0) when timing:true', () => {
    markStart();
    emit(success({}), { timing: true });
    const parsed = JSON.parse(io.stdout[0]);
    expect(typeof parsed.meta.timing_ms).toBe('number');
    expect(parsed.meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(parsed.meta.timing_ms)).toBe(true);
  });

  it('preserves caller-supplied meta when injecting timing_ms', () => {
    markStart();
    const env = success({}, { meta: { cwd: '/repo' } });
    emit(env, { timing: true });
    const parsed = JSON.parse(io.stdout[0]);
    expect(parsed.meta.cwd).toBe('/repo');
    expect(typeof parsed.meta.timing_ms).toBe('number');
  });

  it('does not throw when format is omitted (defaults to json)', () => {
    expect(() => emit(success({}))).not.toThrow();
    const parsed = JSON.parse(io.stdout[0]);
    expect(parsed.ok).toBe(true);
  });

  it('emits JSONL (single line + newline) when format is jsonl', () => {
    emit(success({ x: 1 }), { format: 'jsonl' });
    expect(io.stdout.length).toBe(1);
    expect(io.stdout[0].endsWith('\n')).toBe(true);
    // jsonl is single-line; pretty json contains newlines inside.
    const lineCount = io.stdout[0].split('\n').filter((l) => l.length > 0).length;
    expect(lineCount).toBe(1);
  });

  it('sets process.exitCode when exitCode option is passed', () => {
    const prev = process.exitCode;
    try {
      emit(success({}), { exitCode: 3 });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = prev;
    }
  });
});
