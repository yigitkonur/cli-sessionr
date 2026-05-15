import { EXIT, SessionReaderError } from '../errors.js';
import type { SessionSource } from '../types.js';

export const SOURCES_LIST = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'cursor-agent',
  'commandcode',
  'goose',
  'opencode',
  'kiro',
  'zed',
  'factory',
] as const satisfies readonly SessionSource[];

const SOURCE_ALIASES: Partial<Record<string, SessionSource>> = {
  cc: 'claude',
  cli: 'copilot',
  'copilot-cli': 'copilot',
  cx: 'codex',
  droid: 'factory',
  gm: 'gemini',
};

export function resolveSource(s?: string): SessionSource | undefined {
  if (!s) return undefined;
  const normalized = s.toLowerCase();
  const resolved = SOURCE_ALIASES[normalized] ?? normalized;
  if (isKnownSource(resolved)) return resolved;

  throw new SessionReaderError(`Unknown source "${s}".`, {
    code: 'INVALID_SOURCE',
    exitCode: EXIT.USAGE,
    detail: { provided: s, valid: [...SOURCES_LIST] },
    suggestion: `sessionr list <source> (valid: ${SOURCES_LIST.join(', ')})`,
  });
}

export function parseBounded(
  name: string,
  raw: string | number | undefined,
  def: number,
  min: number,
  max?: number,
): number {
  if (raw == null) return def;
  if (typeof raw === 'string' && raw.trim() === '') {
    throw invalidArg(name, raw, `must be a number >= ${min}`);
  }

  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n)) {
    throw invalidArg(name, raw, 'must be an integer');
  }
  if (n < min) {
    throw invalidArg(name, raw, `must be >= ${min}`);
  }
  if (max != null && n > max) {
    throw invalidArg(name, raw, `must be <= ${max}`);
  }
  return n;
}

function isKnownSource(s: string): s is SessionSource {
  return (SOURCES_LIST as readonly string[]).includes(s);
}

function invalidArg(name: string, raw: string | number, reason: string): SessionReaderError {
  return new SessionReaderError(`${name}: ${reason}`, {
    code: 'INVALID_ARG',
    exitCode: EXIT.USAGE,
    detail: { argument: name, provided: raw, reason },
  });
}
