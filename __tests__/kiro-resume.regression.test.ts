import { describe, expect, it } from 'vitest';
import { EXIT, SessionReaderError } from '../src/errors.js';
import { getResumeHint, formatResumeHintPlain } from '../src/resume.js';
import { buildResumeCommand, buildNewCommand } from '../src/runners.js';

/**
 * wp/05 regression — Kiro resume command surface.
 *
 * Background: the old code returned `direct = "kiro-cli chat --no-interactive
 * --resume"` (or worse, `--resume <message>`), which kiro-cli either rejects
 * outright or interprets as the wrong session target. Because Kiro CLI cannot
 * resume a specific session by ID, the correct behavior is to:
 *
 *   1. Refuse `buildResumeCommand('kiro', …)` with a structured
 *      UNSUPPORTED_OPERATION error (so `sessionr send <kiro-id>` fails fast
 *      with a clear suggestion instead of silently misrouting).
 *   2. Return a resume hint that points the agent at the new-session command
 *      (`sessionr send --new --source kiro -f prompt.md`) with `direct: null`
 *      and `verified: false`.
 *   3. Keep `buildNewCommand('kiro', …)` working — that path is fine and is
 *      the recommended fallback.
 *
 * This file LOCKS those three contracts so future refactors can't reintroduce
 * the "looks like it works but kiro-cli rejects --resume" failure mode.
 */

describe('Kiro resume (wp/05) — refuses targeted resume', () => {
  it('buildResumeCommand("kiro", …) throws UNSUPPORTED_OPERATION', () => {
    expect(() => buildResumeCommand('kiro', 'any-session-id', 'go')).toThrow(SessionReaderError);

    try {
      buildResumeCommand('kiro', 'any-session-id', 'go');
    } catch (err) {
      const sre = err as SessionReaderError;
      expect(sre).toBeInstanceOf(SessionReaderError);
      expect(sre.code).toBe('UNSUPPORTED_OPERATION');
      expect(sre.exitCode).toBe(EXIT.USAGE);
      expect(sre.class).toBe('validation');
      expect(sre.suggestion).toContain('sessionr send --new --source kiro');
    }
  });

  it('error message does not pretend to know a kiro session ID', () => {
    try {
      buildResumeCommand('kiro', 'some-session-id', 'msg');
    } catch (err) {
      const sre = err as SessionReaderError;
      // Should not leak the user-supplied id into the message body (the error
      // is structural, not about that specific id).
      expect(sre.message).not.toContain('some-session-id');
      // Should not produce a literal "--resume <msg>" string anywhere.
      expect(sre.message.toLowerCase()).not.toContain('--resume');
    }
  });
});

describe('Kiro resume hint (wp/05) — points at new-session command', () => {
  it('getResumeHint("kiro", id) returns the new-session command, direct=null, verified=false', () => {
    const hint = getResumeHint('kiro', 'kiro-session-uuid');

    expect(hint.resume).toBe('sessionr send --new --source kiro -f prompt.md');
    expect(hint.resume_async).toBe('sessionr send --new --source kiro -f prompt.md --async');
    expect(hint.direct).toBeNull();
    expect(hint.verified).toBe(false);
    expect(hint.tip).toContain('cannot resume a specific session by ID');
    // The tip must guide the agent toward "start new", not "try --resume":
    expect(hint.tip.toLowerCase()).not.toMatch(/\bkiro-cli .*--resume\b/);
  });

  it('plaintext formatter omits the Direct line because direct is null', () => {
    const text = formatResumeHintPlain('kiro', 'kiro-session-uuid');
    expect(text).toContain('Resume: sessionr send --new --source kiro -f prompt.md');
    expect(text).toContain('Async:  sessionr send --new --source kiro -f prompt.md --async');
    expect(text).not.toContain('Direct:');
    // The "[!] verified" warning fires because verified=false.
    expect(text).toContain('Direct command not verified locally');
  });

  it('does NOT regress: must never produce "kiro-cli ... --resume <id>" or "--resume <message>"', () => {
    const hint = getResumeHint('kiro', 'abc123');
    // None of the resume strings may carry the broken `--resume` form.
    expect(hint.resume).not.toMatch(/--resume\s+abc123/);
    expect(hint.resume_async).not.toMatch(/--resume\s+abc123/);
    expect(hint.tip).not.toMatch(/--resume\s+abc123/);
    expect(hint.direct).toBeNull();
  });
});

describe('Kiro new-session (wp/05) — still supported as the fallback', () => {
  it('buildNewCommand("kiro", message) returns a valid RunCommand without --resume', () => {
    const cmd = buildNewCommand('kiro', 'hello world');
    expect(cmd.bin).toBe('kiro-cli');
    expect(cmd.args).toEqual(['chat', '--no-interactive', 'hello world']);
    // The new-session path must never include `--resume` either.
    expect(cmd.args).not.toContain('--resume');
  });
});
