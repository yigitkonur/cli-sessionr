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

export class SessionReaderError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly detail: Record<string, unknown>;
  readonly suggestion?: string;
  readonly retry: boolean;

  constructor(
    message: string,
    opts?: {
      code?: string;
      exitCode?: ExitCode;
      detail?: Record<string, unknown>;
      suggestion?: string;
      retry?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'SessionReaderError';
    this.code = opts?.code ?? 'UNKNOWN_ERROR';
    this.exitCode = opts?.exitCode ?? EXIT.ERROR;
    this.detail = opts?.detail ?? {};
    this.suggestion = opts?.suggestion;
    this.retry = opts?.retry ?? false;
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
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, {
      code: 'SESSION_NOT_FOUND',
      exitCode: EXIT.NOT_FOUND,
      detail: { session_id: sessionId },
      suggestion: 'sessionr list --output json',
      retry: false,
    });
    this.name = 'SessionNotFoundError';
  }
}

export class ParseError extends SessionReaderError {
  constructor(filePath: string, reason: string) {
    super(`Failed to parse ${filePath}: ${reason}`, {
      code: 'PARSE_ERROR',
      exitCode: EXIT.ERROR,
      detail: { file_path: filePath, reason },
      retry: false,
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
        exitCode: EXIT.USAGE,
        detail: { requested_from: from, requested_to: to, total_messages: total },
        suggestion: `sessionr read <session-id> 1 ${total}`,
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
        exitCode: EXIT.USAGE,
        detail: { requested, available, session_id: sessionId },
        suggestion: `sessionr read ${sessionId} --tokens ${available}`,
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
