import type { SessionListEntry } from './types.js';
import type { ErrorClass } from './output/envelope.js';
import { cmdPrefix } from './util/invocation.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  RATE_LIMITED: 5,
  PARTIAL: 10,
  NO_CHANGES: 42,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Constructor options for SessionReaderError.
 *
 * Phase 3 (er/03): `errorClass` is REQUIRED at the type level. Phase 0
 * shipped it as optional defaulting to 'internal'; Phase 1+2 swept every
 * production call-site to set it explicitly. Making it required now is
 * the compile-time guard that prevents new SessionReaderError sites from
 * regressing back to the 'internal' default.
 *
 * Phase 3 (er/04): `exitCode` is REQUIRED at the type level so every new
 * error throw must pick a semantic exit code (USAGE/NOT_FOUND/AUTH/...).
 * Phase 0 defaulted to ERROR/1, which silently classified validation
 * failures as internal errors for any code path that forgot to set one.
 */
export interface SessionReaderErrorOptions {
  /** Stable identifier, e.g. SESSION_NOT_FOUND. Defaults to UNKNOWN_ERROR. */
  code?: string;
  /** Semantic exit code (er/04). Required so every error picks one explicitly. */
  exitCode: ExitCode;
  /** Machine-readable error class (er/03). Required at the type level. */
  errorClass: ErrorClass;
  detail?: Record<string, unknown>;
  suggestion?: string;
  /**
   * Whether the operation can be retried (er/09). Optional, defaults to
   * false. Set to true only for transient/recoverable conditions (e.g.
   * NEW_SESSION_NOT_DETECTED, JOB_TIMEOUT, transient FS errors).
   */
  retry?: boolean;
  cause?: unknown;
}

export class SessionReaderError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly detail: Record<string, unknown>;
  readonly suggestion?: string;
  readonly retry: boolean;
  /**
   * v2 envelope error class. Phase 3 (er/03) makes this REQUIRED at the
   * constructor type level via SessionReaderErrorOptions so the type checker
   * rejects any new throw site that omits the classification.
   */
  readonly class: ErrorClass;

  constructor(message: string, opts: SessionReaderErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = 'SessionReaderError';
    this.code = opts.code ?? 'UNKNOWN_ERROR';
    this.exitCode = opts.exitCode;
    this.detail = opts.detail ?? {};
    this.suggestion = opts.suggestion;
    this.retry = opts.retry ?? false;
    this.class = opts.errorClass;
  }

  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (Object.keys(this.detail).length > 0) obj.detail = this.detail;
    if (this.suggestion) obj.suggestion = this.suggestion;
    obj.retry = this.retry;
    return obj;
  }
}

export class SessionNotFoundError extends SessionReaderError {
  constructor(
    sessionId: string,
    context?: {
      totalSessions?: number;
      prefixMatches?: SessionListEntry[];
    },
  ) {
    const prefixMatches = context?.prefixMatches ?? [];
    const detail: Record<string, unknown> = {
      session_id: sessionId,
      cwd: process.cwd(),
    };
    if (prefixMatches.length > 1) {
      detail.prefix_matches = prefixMatches.slice(0, 5).map((e) => ({
        id: e.id,
        cwd: e.cwd,
        source: e.source,
      }));
    }

    super(`Session not found: ${sessionId}`, {
      code: 'SESSION_NOT_FOUND',
      errorClass: 'not_found',
      exitCode: EXIT.NOT_FOUND,
      detail,
      suggestion: buildSessionNotFoundSuggestion(sessionId, context?.totalSessions, prefixMatches.length),
      retry: false,
    });
    this.name = 'SessionNotFoundError';
  }
}

function buildSessionNotFoundSuggestion(
  sessionId: string,
  totalSessions: number | undefined,
  prefixMatchCount: number,
): string {
  if (totalSessions === 0) {
    return 'No sessions found anywhere. Run `sessionr doctor` to verify your data dirs.';
  }
  if (prefixMatchCount > 1) {
    return `Prefix "${sessionId}" matches ${prefixMatchCount} sessions; pass a longer prefix.`;
  }
  return 'sessionr list --cwd current  (or --cwd all)';
}

export class ParseError extends SessionReaderError {
  constructor(filePath: string, reason: string) {
    super(`Failed to parse ${filePath}: ${reason}`, {
      code: 'PARSE_ERROR',
      errorClass: 'internal',
      exitCode: EXIT.ERROR,
      detail: { file_path: filePath, reason },
      // er/09: parser errors are transient (corrupt single line, partial
      // flush, etc.) — most parsers already skip and keep going. When the
      // error escapes, the caller may retry after waiting for the writer.
      retry: true,
    });
    this.name = 'ParseError';
  }
}

export class InvalidRangeError extends SessionReaderError {
  constructor(from: number, to: number, total: number) {
    super(
      `Invalid range: messages ${from}-${to} requested, but session has ${total} messages`,
      {
        code: 'INVALID_RANGE',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        detail: { requested_from: from, requested_to: to, total_messages: total },
        suggestion: `${cmdPrefix()} read <session-id> 1 ${total}`,
        retry: false,
      },
    );
    this.name = 'InvalidRangeError';
  }
}

export class TokenBudgetExceededError extends SessionReaderError {
  constructor(requested: number, available: number, sessionId: string) {
    super(
      `Requested ${requested} tokens but session only contains ${available}`,
      {
        code: 'TOKEN_LIMIT_EXCEEDED',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        detail: { requested, available, session_id: sessionId },
        suggestion: `${cmdPrefix()} read ${sessionId} --tokens ${available}`,
        retry: false,
      },
    );
    this.name = 'TokenBudgetExceededError';
  }
}

export function exitCodeForError(err: unknown): ExitCode {
  if (err instanceof SessionReaderError) return err.exitCode;
  return EXIT.ERROR;
}

// ── Parser warnings (er/10) ────────────────────────────────────────────────
//
// JSONL parsers historically swallow ParseError when a single line cannot
// be parsed (the rest of the session is still usable). Phase 3 surfaces
// the COUNT of swallowed warnings so callers see `meta.parser_warnings: N`
// instead of silently losing rows.
//
// This module owns the counter API; the actual instrumentation of the
// individual parsers and the meta-field plumbing live in their respective
// files (src/parsers/* and src/commands/read.ts). Phase 3 lands the
// counter + warning helper so the next sweep can wire it through without
// changing the public API again.
//
// TODO(v3.1): instrument the per-parser swallow points to call
// recordParserWarning() and surface the count via meta.parser_warnings.

let parserWarningCount = 0;

export function recordParserWarning(filePath: string, reason: string): void {
  parserWarningCount += 1;
  if (process.stderr.isTTY) {
    process.stderr.write(
      `[sessionr] parser warning: ${filePath}: ${reason}\n`,
    );
  }
}

export function consumeParserWarnings(): number {
  const n = parserWarningCount;
  parserWarningCount = 0;
  return n;
}

export function peekParserWarnings(): number {
  return parserWarningCount;
}
