import { EXIT, SessionReaderError } from './errors.js';
import type { SessionSource } from './types.js';

export interface RunCommand {
  bin: string;
  args: string[];
}

/**
 * Build the resume-an-existing-session command for `source`. Every branch
 * returns a fully-populated RunCommand or throws a SessionReaderError — never
 * returns undefined (wp/01 prevention). The trailing `_exhaustive: never`
 * triggers a compile-time check that every SessionSource value is handled.
 */
export function buildResumeCommand(
  source: SessionSource | undefined,
  sessionId: string,
  message: string,
): RunCommand {
  if (!source) {
    throw new SessionReaderError('Source could not be determined for resume', {
      code: 'SOURCE_UNKNOWN',
      exitCode: EXIT.NOT_FOUND,
      errorClass: 'not_found',
      suggestion: 'Verify the session exists with: sessionr list --output json',
    });
  }

  switch (source) {
    case 'claude':
      return { bin: 'claude', args: ['-p', '-r', sessionId, message] };
    case 'codex':
      return { bin: 'codex', args: ['exec', 'resume', sessionId, message] };
    case 'gemini':
      return { bin: 'gemini', args: ['-p', message, '-r', sessionId] };
    case 'cursor-agent':
      return { bin: 'agent', args: ['-p', '--resume', sessionId, message] };
    case 'copilot':
      return { bin: 'copilot', args: ['-p', message, `--resume=${sessionId}`] };
    case 'opencode':
      return { bin: 'opencode', args: ['run', '-s', sessionId, message] };
    case 'commandcode':
      return { bin: 'cmd', args: ['-p', message, '--resume', sessionId] };
    case 'goose':
      return { bin: 'goose', args: ['run', '--resume', '--session-id', sessionId, '-t', message] };
    case 'kiro':
      throw new SessionReaderError('Kiro CLI cannot resume a specific session', {
        code: 'UNSUPPORTED_OPERATION',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        suggestion: "sessionr send --new --source kiro -m '...'",
      });
    case 'zed':
      throw new SessionReaderError('Zed AI threads are GUI-only — no CLI send support', {
        code: 'UNSUPPORTED_SOURCE',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        detail: { source },
        suggestion: 'Use a CLI-based tool (claude, codex, gemini, etc.)',
      });
    case 'factory':
      return { bin: 'droid', args: ['exec', '-s', sessionId, message] };
  }

  // Compile-time exhaustiveness check: if a new SessionSource is added without
  // a case above, TypeScript flags this assignment.
  const _exhaustive: never = source;
  throw new SessionReaderError(`Unsupported source: ${String(_exhaustive)}`, {
    code: 'UNSUPPORTED_SOURCE',
    exitCode: EXIT.USAGE,
    errorClass: 'validation',
    detail: { source: _exhaustive },
  });
}

/**
 * Build the new-session command for `source`. Same exhaustiveness contract as
 * buildResumeCommand: every value either returns a RunCommand or throws.
 */
export function buildNewCommand(
  source: SessionSource | undefined,
  message: string,
  cwd?: string,
): RunCommand {
  if (!source) {
    throw new SessionReaderError('Source could not be determined for new session', {
      code: 'SOURCE_UNKNOWN',
      exitCode: EXIT.NOT_FOUND,
      errorClass: 'not_found',
      suggestion: 'Specify a source, e.g. sessionr send --new --source claude -f prompt.md',
    });
  }

  switch (source) {
    case 'claude':
      return { bin: 'claude', args: ['-p', message] };
    case 'codex':
      return { bin: 'codex', args: ['exec', message] };
    case 'gemini':
      return { bin: 'gemini', args: ['-p', message] };
    case 'cursor-agent':
      return { bin: 'agent', args: ['-p', message] };
    case 'copilot':
      return { bin: 'copilot', args: ['-p', message] };
    case 'opencode':
      return { bin: 'opencode', args: ['run', message] };
    case 'commandcode':
      return { bin: 'cmd', args: ['-p', message] };
    case 'goose':
      return { bin: 'goose', args: ['run', '-t', message] };
    case 'kiro':
      return { bin: 'kiro-cli', args: ['chat', '--no-interactive', message] };
    case 'zed':
      throw new SessionReaderError('Zed AI threads are GUI-only — no CLI send support', {
        code: 'UNSUPPORTED_SOURCE',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        detail: { source },
        suggestion: 'Use a CLI-based tool (claude, codex, gemini, etc.)',
      });
    case 'factory':
      return { bin: 'droid', args: ['exec', message] };
  }

  // Exhaustiveness check — see buildResumeCommand above.
  const _exhaustive: never = source;
  throw new SessionReaderError(`Unsupported source: ${String(_exhaustive)}`, {
    code: 'UNSUPPORTED_SOURCE',
    exitCode: EXIT.USAGE,
    errorClass: 'validation',
    detail: { source: _exhaustive },
  });
}

export function canSend(source: SessionSource): boolean {
  return source !== 'zed';
}
