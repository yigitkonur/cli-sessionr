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

// dc/05: alias map — let agents use the names they think in (`cc` for
// Claude Code, `gpt`/`openai`/`oai` for Codex/OpenAI). Aliases are
// normalised to canonical SessionSource names before any downstream check
// runs, so the rest of the codebase only ever sees a canonical value.
const SOURCE_ALIASES: Partial<Record<string, SessionSource>> = {
  cc: 'claude',
  'claude-code': 'claude',
  cli: 'copilot',
  'copilot-cli': 'copilot',
  cx: 'codex',
  gpt: 'codex',
  openai: 'codex',
  oai: 'codex',
  droid: 'factory',
  gm: 'gemini',
};

export const SOURCE_ALIASES_LIST = Object.entries(SOURCE_ALIASES).map(
  ([alias, canonical]) => `${alias}→${canonical}`,
);

export function resolveSource(s?: string): SessionSource | undefined {
  if (!s) return undefined;
  const normalized = s.toLowerCase();
  const resolved = SOURCE_ALIASES[normalized] ?? normalized;
  if (isKnownSource(resolved)) return resolved;

  throw new SessionReaderError(`Unknown source "${s}".`, {
    code: 'INVALID_SOURCE',
    errorClass: 'validation',
    exitCode: EXIT.USAGE,
    detail: {
      provided: s,
      valid: [...SOURCES_LIST],
      aliases: SOURCE_ALIASES_LIST,
    },
    suggestion: `Use one of: ${SOURCES_LIST.join(', ')} (aliases: ${SOURCE_ALIASES_LIST.join(', ')})`,
  });
}

/**
 * Validate one of a fixed set of role names (er/08). Throws a properly-
 * coded INVALID_ROLE error (not INVALID_RANGE) when an unknown role is
 * supplied, e.g. `--role badrolename`. Centralising the check here lets
 * non-read callers (context, search, ...) reuse the same error code.
 */
export const VALID_ROLES = [
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
] as const;

export function validateRoles(raw: string): string[] {
  const roles = raw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const unknown = roles.filter((r) => !(VALID_ROLES as readonly string[]).includes(r));
  if (unknown.length === 0) return roles;

  throw new SessionReaderError(`Unknown role(s): ${unknown.join(', ')}`, {
    code: 'INVALID_ROLE',
    errorClass: 'validation',
    exitCode: EXIT.USAGE,
    detail: { provided: roles, unknown, valid: [...VALID_ROLES] },
    suggestion: 'sessionr read <id> --role user,assistant',
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
  // er/06: when the reason names a numeric bound (`must be >= N` or
  // `must be <= N`), use INVALID_RANGE so the error code semantically
  // matches "value outside accepted range" rather than the generic
  // INVALID_ARG bucket. The canonical example is `--tokens 0`, which used
  // to be silently accepted; now it bubbles up with INVALID_RANGE.
  const isRangeBound = /must be (>=|<=)/.test(reason);
  return new SessionReaderError(`${name}: ${reason}`, {
    code: isRangeBound ? 'INVALID_RANGE' : 'INVALID_ARG',
    errorClass: 'validation',
    exitCode: EXIT.USAGE,
    detail: { argument: name, provided: raw, reason },
  });
}
