import { describe, expect, it } from 'vitest';
import { SessionReaderError, EXIT } from '../src/errors.js';
import { buildNewCommand, buildResumeCommand } from '../src/runners.js';

describe('runner command builders', () => {
  it('throws SOURCE_UNKNOWN when resume source is missing', () => {
    expect(() => buildResumeCommand(undefined, 'deadbeef', 'ping')).toThrow(SessionReaderError);

    try {
      buildResumeCommand(undefined, 'deadbeef', 'ping');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as SessionReaderError).code).toBe('SOURCE_UNKNOWN');
      expect((err as SessionReaderError).exitCode).toBe(EXIT.NOT_FOUND);
    }
  });

  it('throws SOURCE_UNKNOWN when new-session source is missing', () => {
    expect(() => buildNewCommand(undefined, 'ping')).toThrow(SessionReaderError);

    try {
      buildNewCommand(undefined, 'ping');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      expect((err as SessionReaderError).code).toBe('SOURCE_UNKNOWN');
      expect((err as SessionReaderError).exitCode).toBe(EXIT.NOT_FOUND);
    }
  });
});
