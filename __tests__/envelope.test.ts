import { describe, it, expect } from 'vitest';
import { success, failure, SCHEMA_VERSION } from '../src/output/envelope.js';
import type { V2Action, V2Meta } from '../src/output/envelope.js';

describe('envelope: success()', () => {
  it('returns ok:true with result and schema_version v2', () => {
    const env = success({ foo: 1 });
    expect(env).toEqual({
      ok: true,
      schema_version: 'v2',
      result: { foo: 1 },
    });
    expect(env.schema_version).toBe(SCHEMA_VERSION);
  });

  it('never sets error on a success envelope', () => {
    const env = success({ a: 1 });
    expect(env.error).toBeUndefined();
  });

  it('round-trips meta and actions when supplied', () => {
    const meta: V2Meta = { cwd: '/repo', etag: 'abc', cwd_scope: 'auto' };
    const actions: V2Action[] = [
      { command: 'sessionr list', description: 'see all sessions' },
    ];
    const env = success({ x: true }, { meta, actions });
    expect(env.meta).toEqual(meta);
    expect(env.actions).toEqual(actions);
  });
});

describe('envelope: failure()', () => {
  it('returns ok:false with error and schema_version v2', () => {
    const env = failure({
      class: 'not_found',
      code: 'X',
      message: 'm',
      retryable: false,
    });
    expect(env).toEqual({
      ok: false,
      schema_version: 'v2',
      error: {
        class: 'not_found',
        code: 'X',
        message: 'm',
        retryable: false,
      },
    });
  });

  it('never sets result on a failure envelope', () => {
    const env = failure({
      class: 'internal',
      code: 'BOOM',
      message: 'oops',
      retryable: false,
    });
    expect(env.result).toBeUndefined();
  });

  it('round-trips meta when supplied', () => {
    const meta: V2Meta = { timing_ms: 42 };
    const env = failure(
      { class: 'validation', code: 'BAD', message: 'no', retryable: false },
      { meta },
    );
    expect(env.meta).toEqual(meta);
  });

  it('preserves detail and suggestion on the error object', () => {
    const env = failure({
      class: 'rate_limit',
      code: 'RL',
      message: 'slow down',
      detail: { retry_after_s: 30 },
      suggestion: 'wait and retry',
      retryable: true,
    });
    expect(env.error?.detail).toEqual({ retry_after_s: 30 });
    expect(env.error?.suggestion).toBe('wait and retry');
    expect(env.error?.retryable).toBe(true);
  });
});
