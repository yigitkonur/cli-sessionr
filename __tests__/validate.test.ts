import { describe, expect, it } from 'vitest';
import { EXIT, SessionReaderError } from '../src/errors.js';
import { parseBounded, resolveSource } from '../src/utils/validate.js';

describe('resolveSource', () => {
  it('accepts known sources', () => {
    expect(resolveSource('claude')).toBe('claude');
    expect(resolveSource('factory')).toBe('factory');
  });

  it('resolves lightweight aliases', () => {
    expect(resolveSource('cc')).toBe('claude');
    expect(resolveSource('cli')).toBe('copilot');
    expect(resolveSource('copilot-cli')).toBe('copilot');
    expect(resolveSource('cx')).toBe('codex');
    expect(resolveSource('gm')).toBe('gemini');
    expect(resolveSource('droid')).toBe('factory');
  });

  it('rejects unknown sources with usage error', () => {
    expect(() => resolveSource('claud')).toThrow(SessionReaderError);
    try {
      resolveSource('claud');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as SessionReaderError).code).toBe('INVALID_SOURCE');
      expect((err as SessionReaderError).exitCode).toBe(EXIT.USAGE);
      expect((err as SessionReaderError).detail.provided).toBe('claud');
    }
  });
});

describe('parseBounded', () => {
  it('returns defaults for missing values', () => {
    expect(parseBounded('--limit', undefined, 20, 1, 1000)).toBe(20);
  });

  it('rejects non-positive limits and negative offsets', () => {
    expect(() => parseBounded('--limit', '0', 20, 1, 1000)).toThrow(SessionReaderError);
    expect(() => parseBounded('--limit', '-5', 20, 1, 1000)).toThrow(SessionReaderError);
    expect(() => parseBounded('--offset', '-1', 0, 0)).toThrow(SessionReaderError);
  });

  it('rejects numeric junk', () => {
    expect(() => parseBounded('--limit', 'abc', 20, 1, 1000)).toThrow(SessionReaderError);
    expect(() => parseBounded('--limit', '12abc', 20, 1, 1000)).toThrow(SessionReaderError);
    expect(() => parseBounded('--limit', '1.5', 20, 1, 1000)).toThrow(SessionReaderError);
  });

  it('rejects values above max', () => {
    expect(() => parseBounded('--limit', '1001', 20, 1, 1000)).toThrow(SessionReaderError);
  });
});
