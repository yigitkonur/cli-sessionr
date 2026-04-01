import { describe, it, expect } from 'vitest';
import {
  SessionReaderError,
  SessionNotFoundError,
  ParseError,
  InvalidRangeError,
  TokenBudgetExceededError,
  EXIT,
  exitCodeForError,
} from '../src/errors.js';

describe('EXIT codes', () => {
  it('defines expected exit codes', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.ERROR).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.NOT_FOUND).toBe(3);
    expect(EXIT.NO_CHANGES).toBe(42);
  });
});

describe('SessionReaderError', () => {
  it('has structured fields', () => {
    const err = new SessionReaderError('test', {
      code: 'TEST',
      exitCode: EXIT.USAGE,
      detail: { foo: 'bar' },
      suggestion: 'do something',
      retry: true,
    });
    expect(err.code).toBe('TEST');
    expect(err.exitCode).toBe(2);
    expect(err.detail).toEqual({ foo: 'bar' });
    expect(err.suggestion).toBe('do something');
    expect(err.retry).toBe(true);
  });

  it('toJSON produces machine-readable object', () => {
    const err = new SessionReaderError('oops', {
      code: 'FAIL',
      detail: { x: 1 },
      suggestion: 'fix it',
    });
    const json = err.toJSON();
    expect(json.code).toBe('FAIL');
    expect(json.message).toBe('oops');
    expect(json.detail).toEqual({ x: 1 });
    expect(json.suggestion).toBe('fix it');
    expect(json.retry).toBe(false);
  });

  it('toJSON omits empty detail', () => {
    const err = new SessionReaderError('msg', { code: 'X' });
    const json = err.toJSON();
    expect(json.detail).toBeUndefined();
  });
});

describe('SessionNotFoundError', () => {
  it('has NOT_FOUND exit code and suggestion', () => {
    const err = new SessionNotFoundError('abc123');
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.suggestion).toContain('list');
    expect(err.detail.session_id).toBe('abc123');
  });
});

describe('ParseError', () => {
  it('has ERROR exit code', () => {
    const err = new ParseError('/tmp/f.jsonl', 'bad format');
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.code).toBe('PARSE_ERROR');
  });
});

describe('InvalidRangeError', () => {
  it('has USAGE exit code and range detail', () => {
    const err = new InvalidRangeError(5, 100, 50);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.code).toBe('INVALID_RANGE');
    expect(err.detail.requested_from).toBe(5);
    expect(err.detail.total_messages).toBe(50);
  });
});

describe('TokenBudgetExceededError', () => {
  it('has USAGE exit code and token detail', () => {
    const err = new TokenBudgetExceededError(50000, 12340, 'sess_abc');
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.code).toBe('TOKEN_LIMIT_EXCEEDED');
    expect(err.detail.requested).toBe(50000);
    expect(err.detail.available).toBe(12340);
    expect(err.suggestion).toContain('12340');
  });
});

describe('exitCodeForError', () => {
  it('returns error exitCode for SessionReaderError', () => {
    expect(exitCodeForError(new SessionNotFoundError('x'))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeForError(new InvalidRangeError(1, 2, 3))).toBe(EXIT.USAGE);
  });

  it('returns ERROR for unknown errors', () => {
    expect(exitCodeForError(new Error('random'))).toBe(EXIT.ERROR);
    expect(exitCodeForError('string error')).toBe(EXIT.ERROR);
  });
});
