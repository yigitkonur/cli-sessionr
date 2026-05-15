import { describe, expect, it } from 'vitest';
import { EXIT, SessionReaderError } from '../src/errors.js';
import { getResumeHint } from '../src/resume.js';
import { buildResumeCommand } from '../src/runners.js';

describe('Kiro targeted resume', () => {
  it('refuses targeted send with a structured unsupported-operation error', () => {
    expect(() => buildResumeCommand('kiro', 'known-kiro-id', 'ping')).toThrow(SessionReaderError);

    try {
      buildResumeCommand('kiro', 'known-kiro-id', 'ping');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionReaderError);
      const error = err as SessionReaderError;
      expect(error.code).toBe('UNSUPPORTED_OPERATION');
      expect(error.exitCode).toBe(EXIT.USAGE);
      expect(error.suggestion).toBe("sessionr send --new --source kiro -m '...'");
    }
  });

  it('emits a resume hint that matches the refused operation', () => {
    const hint = getResumeHint('kiro', 'known-kiro-id');

    expect(hint.resume).toBe('sessionr send --new --source kiro -f prompt.md');
    expect(hint.resume_async).toBe('sessionr send --new --source kiro -f prompt.md --async');
    expect(hint.direct).toBeNull();
    expect(hint.verified).toBe(false);
    expect(hint.tip).toContain('cannot resume a specific session by ID');
  });
});
