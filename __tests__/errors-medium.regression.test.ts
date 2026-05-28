/**
 * Phase 3 regression coverage for the er/* MEDIUM error fixes:
 *   - er/03 errorClass required at the type level
 *   - er/04 exit codes semantic per throw
 *   - er/05 getPreset throws structured SessionReaderError
 *   - er/06 --tokens 0 rejects with INVALID_RANGE (not silently accepted)
 *   - er/08 --role badrole returns INVALID_ROLE (not INVALID_RANGE)
 *   - er/09 retry semantics — transient errors set retry:true
 *
 * The TypeScript-level enforcement (er/03) is verified at compile time;
 * this suite covers the runtime/behavioural slice.
 */
import { describe, it, expect } from 'vitest';
import {
  SessionReaderError,
  ParseError,
  SessionNotFoundError,
  InvalidRangeError,
  TokenBudgetExceededError,
  EXIT,
} from '../src/errors.js';
import { getPreset } from '../src/config.js';
import { parseBounded, validateRoles } from '../src/utils/validate.js';

describe('er/03 — errorClass is required at the constructor type level', () => {
  it('class field always reflects the supplied errorClass', () => {
    const v = new SessionReaderError('m', {
      code: 'X',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
    expect(v.class).toBe('validation');

    const n = new SessionReaderError('m', {
      code: 'X',
      errorClass: 'not_found',
      exitCode: EXIT.NOT_FOUND,
    });
    expect(n.class).toBe('not_found');

    const i = new SessionReaderError('m', {
      code: 'X',
      errorClass: 'internal',
      exitCode: EXIT.ERROR,
    });
    expect(i.class).toBe('internal');

    const p = new SessionReaderError('m', {
      code: 'X',
      errorClass: 'partial',
      exitCode: EXIT.PARTIAL,
    });
    expect(p.class).toBe('partial');
  });

  it('subclasses carry an explicit errorClass through super()', () => {
    expect(new SessionNotFoundError('abc').class).toBe('not_found');
    expect(new ParseError('/x', 'bad').class).toBe('internal');
    expect(new InvalidRangeError(1, 2, 0).class).toBe('validation');
    expect(new TokenBudgetExceededError(1, 0, 'x').class).toBe('validation');
  });
});

describe('er/04 — semantic exit codes', () => {
  it('SessionNotFoundError → NOT_FOUND (3)', () => {
    expect(new SessionNotFoundError('x').exitCode).toBe(EXIT.NOT_FOUND);
  });
  it('InvalidRangeError → USAGE (2)', () => {
    expect(new InvalidRangeError(1, 2, 0).exitCode).toBe(EXIT.USAGE);
  });
  it('TokenBudgetExceededError → USAGE (2)', () => {
    expect(new TokenBudgetExceededError(1, 0, 'x').exitCode).toBe(EXIT.USAGE);
  });
  it('ParseError → ERROR (1)', () => {
    expect(new ParseError('/x', 'bad').exitCode).toBe(EXIT.ERROR);
  });
});

describe('er/05 — getPreset throws structured SessionReaderError', () => {
  it('returns a known preset for a valid name', () => {
    expect(getPreset('standard').name).toBe('standard');
  });

  it('throws INVALID_PRESET (validation, USAGE) for an unknown name', () => {
    try {
      getPreset('chatty');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      const sre = err as SessionReaderError;
      expect(sre.code).toBe('INVALID_PRESET');
      expect(sre.class).toBe('validation');
      expect(sre.exitCode).toBe(EXIT.USAGE);
      expect(sre.detail.provided).toBe('chatty');
      expect(Array.isArray(sre.detail.valid)).toBe(true);
    }
  });
});

describe('er/06 — --tokens 0 (and any min-bound flag) rejects with INVALID_RANGE', () => {
  it('rejects "0" with INVALID_RANGE when min is 1', () => {
    try {
      parseBounded('--tokens', '0', 0, 1);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      const sre = err as SessionReaderError;
      expect(sre.code).toBe('INVALID_RANGE');
      expect(sre.class).toBe('validation');
      expect(sre.exitCode).toBe(EXIT.USAGE);
    }
  });

  it('rejects negative values with INVALID_RANGE', () => {
    try {
      parseBounded('--tokens', '-5', 0, 1);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as SessionReaderError).code).toBe('INVALID_RANGE');
    }
  });

  it('rejects values above max with INVALID_RANGE', () => {
    try {
      parseBounded('--limit', '9999', 0, 1, 1000);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as SessionReaderError).code).toBe('INVALID_RANGE');
    }
  });

  it('non-numeric input still surfaces as INVALID_ARG (not range)', () => {
    try {
      parseBounded('--tokens', 'abc', 0, 1);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as SessionReaderError).code).toBe('INVALID_ARG');
    }
  });
});

describe('er/08 — --role badrolename throws INVALID_ROLE, not INVALID_RANGE', () => {
  it('rejects unknown roles with INVALID_ROLE', () => {
    try {
      validateRoles('badrolename');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      const sre = err as SessionReaderError;
      expect(sre.code).toBe('INVALID_ROLE');
      expect(sre.code).not.toBe('INVALID_RANGE');
      expect(sre.class).toBe('validation');
      expect(sre.exitCode).toBe(EXIT.USAGE);
      expect(sre.detail.unknown).toEqual(['badrolename']);
    }
  });

  it('accepts a comma-separated mix of valid roles', () => {
    expect(validateRoles('user,assistant')).toEqual(['user', 'assistant']);
  });

  it('mixed valid + invalid still throws INVALID_ROLE listing the bad ones', () => {
    try {
      validateRoles('user,wat,assistant,nope');
      throw new Error('expected throw');
    } catch (err) {
      const sre = err as SessionReaderError;
      expect(sre.code).toBe('INVALID_ROLE');
      expect(sre.detail.unknown).toEqual(['wat', 'nope']);
    }
  });
});

describe('er/09 — retry semantics on transient errors', () => {
  it('ParseError sets retry:true (transient file/parser issue)', () => {
    expect(new ParseError('/x', 'bad').retry).toBe(true);
  });

  it('SessionNotFoundError is non-retryable (terminal)', () => {
    expect(new SessionNotFoundError('x').retry).toBe(false);
  });

  it('validation errors are non-retryable (caller must fix input)', () => {
    expect(new InvalidRangeError(1, 2, 0).retry).toBe(false);
    expect(new TokenBudgetExceededError(1, 0, 'x').retry).toBe(false);
  });
});

describe('er/10 — parser warning counter API', () => {
  it('records and consumes warning counts', async () => {
    const mod = await import('../src/errors.js');
    // Reset counter before this assertion.
    mod.consumeParserWarnings();
    expect(mod.peekParserWarnings()).toBe(0);
    mod.recordParserWarning('/tmp/x.jsonl', 'line 5: malformed');
    mod.recordParserWarning('/tmp/y.jsonl', 'line 9: malformed');
    expect(mod.peekParserWarnings()).toBe(2);
    expect(mod.consumeParserWarnings()).toBe(2);
    expect(mod.peekParserWarnings()).toBe(0);
  });
});
