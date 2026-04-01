import type { SessionSource } from './types.js';

export interface RunCommand {
  bin: string;
  args: string[];
}

export function buildResumeCommand(
  source: SessionSource,
  sessionId: string,
  message: string,
): RunCommand {
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
      return { bin: 'kiro-cli', args: ['chat', '--no-interactive', '--resume', message] };
    case 'zed':
      throw new Error('Zed AI threads are GUI-only — no CLI send support');
  }
}

export function buildNewCommand(
  source: SessionSource,
  message: string,
  cwd?: string,
): RunCommand {
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
      throw new Error('Zed AI threads are GUI-only — no CLI send support');
  }
}

export function canSend(source: SessionSource): boolean {
  return source !== 'zed';
}
