import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { loadSession, listSessions } from '../discovery.js';
import { buildResumeCommand, buildNewCommand, canSend, type RunCommand } from '../runners.js';
import { createJob, generateJobId, jobExitPath } from '../jobs.js';
import { createFormatter } from '../output/formatter.js';
import { serializeMessage } from '../output/serialize.js';
import { getPreset, getDefaultTokenBudget } from '../config.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { SessionReaderError, EXIT, exitCodeForError } from '../errors.js';
import { resolveSourceAlias } from '../parsers/registry.js';
import { cmdPrefix } from '../util/invocation.js';
import { failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import type { SessionSource, SendOptions, OutputFormat, SliceMeta } from '../types.js';

const JOBS_DIR = join(homedir(), '.sessionreader', 'jobs');

/**
 * Resolve the user-supplied prompt from `--message` / `--file`. All three
 * validation branches (conflicting, file unreadable, missing) throw a
 * structured `SessionReaderError` (validation class) so the top-level
 * try/catch can route them through the v2 envelope via emit(failure()).
 *
 * oc/05 fix: these checks MUST run AFTER the formatter is initialised so
 * `--output json` callers see a parseable error envelope on stdout.
 */
function resolveMessage(opts: SendOptions): string {
  const hasMessage = typeof opts.message === 'string' && opts.message.length > 0;
  const hasFile = typeof opts.file === 'string' && opts.file.length > 0;

  if (hasMessage && hasFile) {
    throw new SessionReaderError('--message and --file are mutually exclusive', {
      code: 'CONFLICTING_FLAGS',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      suggestion: 'sessionr send <id> -m "text"  OR  sessionr send <id> -f prompt.md',
    });
  }

  if (hasFile) {
    try {
      return readFileSync(opts.file as string, 'utf-8').trim();
    } catch (err) {
      throw new SessionReaderError(`Cannot read file "${opts.file}"`, {
        code: 'FILE_NOT_READABLE',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        detail: { path: opts.file, cause: (err as Error).message },
        suggestion: `Check that ${opts.file} exists and is readable`,
        cause: err,
      });
    }
  }

  if (hasMessage) {
    return opts.message as string;
  }

  throw new SessionReaderError('Either --message or --file is required', {
    code: 'MISSING_MESSAGE',
    exitCode: EXIT.USAGE,
    errorClass: 'validation',
    suggestion: 'sessionr send <id> -m "your prompt"',
  });
}

/**
 * Guard: refuse to call spawn() with a partially-resolved RunCommand. The v2
 * runner builders should always raise SOURCE_UNKNOWN before returning a
 * malformed shape, but the guard prevents wp/01-style undefined-property
 * TypeErrors if a code path ever slips through.
 */
function assertSpawnable(cmd: RunCommand | undefined | null): asserts cmd is RunCommand {
  if (
    !cmd ||
    typeof cmd.bin !== 'string' ||
    cmd.bin.length === 0 ||
    !Array.isArray(cmd.args)
  ) {
    throw new SessionReaderError('Spawn command could not be resolved', {
      code: 'UNRESOLVED_SPAWN_COMMAND',
      exitCode: EXIT.ERROR,
      errorClass: 'internal',
      detail: cmd ? { bin: cmd.bin ?? null, args_type: typeof cmd.args } : { cmd: null },
      retry: false,
      suggestion: 'sessionr doctor   (verify tool installation)',
    });
  }
}

export async function sendCommand(
  sessionId: string | undefined,
  opts: SendOptions,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });
  // emit() needs the raw format string to choose JSONL vs pretty JSON.
  // The formatter resolves text/table for TTY; for the v2 error path we
  // route through emit() so the error envelope shape matches Phase 0.
  const format: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');

  try {
    // oc/05: resolve message AFTER the formatter exists so validation errors
    // surface as v2 envelopes on stdout in JSON mode.
    const message = resolveMessage(opts);

    const isNew = opts.new === true;
    let source = resolveSource(sessionId, opts.source, isNew);

    const cwd = opts.cwd ?? process.cwd();

    // Snapshot message count before send + auto-detect source
    let messageCountBefore = 0;
    let resolvedSessionId = sessionId ?? null;

    if (!isNew && resolvedSessionId) {
      const session = await loadSession(resolvedSessionId, source);
      messageCountBefore = session.stats.totalMessages;
      resolvedSessionId = session.id;
      if (!opts.source) source = session.source;
    }

    if (!source) {
      throw new SessionReaderError('Source could not be determined for send', {
        code: 'SOURCE_UNKNOWN',
        exitCode: EXIT.NOT_FOUND,
        errorClass: 'not_found',
        suggestion: 'Verify the session exists with: sessionr list --output json',
      });
    }

    if (!canSend(source)) {
      throw new SessionReaderError('Zed AI threads are GUI-only — no CLI send support', {
        code: 'UNSUPPORTED_SOURCE',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        detail: { source },
        suggestion: 'Use a CLI-based tool (claude, codex, gemini, etc.)',
      });
    }

    // Build the command (with safety guard against malformed RunCommand shapes).
    const cmd = isNew
      ? buildNewCommand(source, message, cwd)
      : buildResumeCommand(source, resolvedSessionId!, message);
    assertSpawnable(cmd);

    if (opts.async) {
      await runAsync(cmd, resolvedSessionId, source, cwd, { ...opts, message }, messageCountBefore, isNew, formatter);
    } else {
      await runSync(cmd, resolvedSessionId, source, cwd, { ...opts, message }, messageCountBefore, isNew, formatter);
    }
  } catch (err) {
    const sre =
      err instanceof SessionReaderError
        ? err
        : new SessionReaderError(err instanceof Error ? err.message : String(err), {
            code: 'UNKNOWN_ERROR',
            exitCode: EXIT.ERROR,
            errorClass: 'internal',
            cause: err,
          });

    emit(
      failure({
        class: sre.class,
        code: sre.code,
        message: sre.message,
        ...(Object.keys(sre.detail).length > 0 ? { detail: sre.detail } : {}),
        ...(sre.suggestion ? { suggestion: sre.suggestion } : {}),
        retryable: sre.retry,
      }),
      { format, exitCode: exitCodeForError(sre) },
    );
  }
}

function resolveSource(
  sessionId: string | undefined,
  sourceOpt: string | undefined,
  isNew: boolean,
): SessionSource | undefined {
  if (sourceOpt) return resolveSourceAlias(sourceOpt);
  if (isNew) {
    throw new SessionReaderError('--source is required when creating a new session', {
      code: 'MISSING_SOURCE',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      suggestion: 'sessionr send --new --source claude -f prompt.md',
    });
  }
  if (!sessionId) {
    throw new SessionReaderError('Either <session-id> or --new --source is required', {
      code: 'MISSING_SESSION',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
      suggestion: 'sessionr send <session-id> -f prompt.md OR --new --source claude -f prompt.md',
    });
  }
  // Source will be auto-detected from session metadata before command build.
  return undefined;
}

async function runSync(
  cmd: RunCommand,
  sessionId: string | null,
  source: SessionSource,
  cwd: string,
  opts: SendOptions,
  messageCountBefore: number,
  isNew: boolean,
  formatter: ReturnType<typeof createFormatter>,
): Promise<void> {
  const resolvedSource = source;

  // wp/02 + wp/06: anchor the detect-new-session window to a timestamp captured
  // BEFORE the child runs so we never attach to a session created earlier by
  // another tool. Allow 2s of clock skew slop.
  const beforeSendT = Date.now();

  const result = await spawnAndWait(cmd, cwd);

  if (result.exitCode !== 0) {
    const detail: Record<string, unknown> = {
      tool: cmd.bin,
      exit_code: result.exitCode,
      source: resolvedSource,
    };
    if (result.stderrTail.length > 0) {
      detail.stderr_tail = result.stderrTail.join('\n');
    }
    if (result.stdoutTail.length > 0) {
      detail.stdout_tail = result.stdoutTail.join('\n');
    }

    throw new SessionReaderError(`Tool exited with code ${result.exitCode}`, {
      code: 'TOOL_ERROR',
      exitCode: EXIT.ERROR,
      detail,
      suggestion: `Check ${cmd.bin} output for errors`,
    });
  }

  // Find the session and get new messages
  let finalSessionId = sessionId;
  if (isNew) {
    finalSessionId = await detectNewSession(resolvedSource, cwd, beforeSendT);
  }

  if (!finalSessionId) {
    if (isNew) {
      throw new SessionReaderError('Tool completed but new session was not detected in cwd', {
        code: 'NEW_SESSION_NOT_DETECTED',
        exitCode: EXIT.PARTIAL,
        errorClass: 'partial',
        detail: { source: resolvedSource, cwd, hint: 'session may take a moment to flush' },
        suggestion: `sessionr list --cwd current --source ${resolvedSource} -n 5`,
        retry: true,
      });
    }

    throw new SessionReaderError('Session could not be determined after send', {
      code: 'SESSION_NOT_FOUND',
      exitCode: EXIT.NOT_FOUND,
      errorClass: 'not_found',
      detail: { source: resolvedSource },
      suggestion: 'sessionr list --output json',
    });
  }

  const session = await loadSession(finalSessionId, resolvedSource);
  const newMessages = session.messages.slice(messageCountBefore);
  const tokenBudget = opts.tokens ?? getDefaultTokenBudget();

  let outputMessages = newMessages;
  let meta: SliceMeta | undefined;

  if (tokenBudget && newMessages.length > 0) {
    const result = sliceByTokenBudget(
      newMessages,
      tokenBudget,
      session.id,
      session.source,
      'tail',
    );
    outputMessages = result.messages;
    meta = result.meta;
  }

  const preset = getPreset(opts.preset ?? 'standard');
  const from = newMessages.length > 0 ? newMessages[0].index : 0;
  const to = newMessages.length > 0 ? newMessages[newMessages.length - 1].index : 0;

  const envelope: Record<string, unknown> = {
    api_version: 1,
    meta: meta ?? {
      session_id: session.id,
      source: session.source,
      total_messages: session.stats.totalMessages,
      message_count_before: messageCountBefore,
      message_count_after: session.stats.totalMessages,
      new_messages: newMessages.length,
      total_tokens_estimate: estimateSessionTokens(session.messages),
      returned_tokens_estimate: estimateSessionTokens(outputMessages),
      range: { from, to },
      is_new_session: isNew,
    },
  };

  // Add send-specific fields to meta
  if (meta) {
    (envelope.meta as Record<string, unknown>).message_count_before = messageCountBefore;
    (envelope.meta as Record<string, unknown>).message_count_after = session.stats.totalMessages;
    (envelope.meta as Record<string, unknown>).new_messages = newMessages.length;
    (envelope.meta as Record<string, unknown>).is_new_session = isNew;
  }

  envelope.messages = outputMessages.map(serializeMessage);

  envelope.actions = [
    {
      command: `${cmdPrefix()} read ${session.id} --after ${messageCountBefore}`,
      description: 'Re-read new messages',
    },
  ];

  console.log(JSON.stringify(envelope, dateReplacer, 2));
}

async function runAsync(
  cmd: RunCommand,
  sessionId: string | null,
  source: SessionSource,
  cwd: string,
  opts: SendOptions,
  messageCountBefore: number,
  isNew: boolean,
  formatter: ReturnType<typeof createFormatter>,
): Promise<void> {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch (err) {
    throw new SessionReaderError(`Failed to prepare async jobs directory: ${(err as Error).message}`, {
      code: 'ASYNC_SETUP_ERROR',
      exitCode: EXIT.ERROR,
      detail: { jobs_dir: JOBS_DIR, error: (err as Error).message },
      suggestion: 'Ensure the jobs directory is writable',
      cause: err,
    });
  }

  const jobId = generateJobId();
  const stdoutFile = join(JOBS_DIR, `${jobId}.stdout`);
  const stderrFile = join(JOBS_DIR, `${jobId}.stderr`);
  const exitFile = jobExitPath(jobId);

  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  let child: ChildProcess | null = null;
  try {
    stdoutFd = openSync(stdoutFile, 'a');
    stderrFd = openSync(stderrFile, 'a');
    child = spawn(
      'bash',
      [
        '-c',
        'exit_file=$1; shift; "$@"; code=$?; printf "%s\\n" "$code" > "$exit_file"; exit "$code"',
        'sessionr-job-wrapper',
        exitFile,
        cmd.bin,
        ...cmd.args,
      ],
      {
        cwd,
        detached: true,
        // stdio: child stdout/stderr go straight to sidecar files so the parent
        // can return immediately without buffering the child's output in
        // memory. wp/03: synchronous mode buffers via spawnAndWait() instead.
        stdio: ['ignore', stdoutFd, stderrFd],
      },
    );
  } catch (err) {
    throw new SessionReaderError(`Failed to start async job for ${cmd.bin}: ${(err as Error).message}`, {
      code: 'ASYNC_SETUP_ERROR',
      exitCode: EXIT.ERROR,
      detail: { tool: cmd.bin, error: (err as Error).message },
      suggestion: `Ensure ${cmd.bin} is installed and the jobs directory is writable`,
      cause: err,
    });
  } finally {
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
  }

  if (!child?.pid) {
    throw new SessionReaderError(`Failed to spawn ${cmd.bin}`, {
      code: 'SPAWN_ERROR',
      exitCode: EXIT.ERROR,
      detail: { tool: cmd.bin },
      suggestion: `Ensure ${cmd.bin} is installed and in PATH`,
    });
  }

  let job;
  try {
    job = createJob({
      id: jobId,
      sessionId,
      source,
      readBack: { source, tokens: opts.tokens, preset: opts.preset },
      cwd,
      message: opts.message ?? '',
      pid: child.pid,
      messageCountBefore,
      isNewSession: isNew,
      stdoutFile,
      stderrFile,
    });
  } catch (err) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Best effort cleanup for a job that could not be persisted.
      }
    }
    throw new SessionReaderError(`Failed to persist async job: ${(err as Error).message}`, {
      code: 'ASYNC_SETUP_ERROR',
      exitCode: EXIT.ERROR,
      detail: { job_id: jobId, error: (err as Error).message },
      suggestion: 'Ensure the jobs directory is writable',
      cause: err,
    });
  }

  child.unref();

  const result = {
    api_version: 1,
    data: {
      job_id: job.id,
      session_id: sessionId,
      source,
      status: 'running',
      pid: child.pid,
      started_at: job.started_at,
      is_new_session: isNew,
      message_count_before: messageCountBefore,
    },
    actions: [
      { command: `${cmdPrefix()} job ${jobId}`, description: 'Check job status' },
      { command: `${cmdPrefix()} wait ${jobId}`, description: 'Wait for completion' },
      { command: `${cmdPrefix()} cancel ${jobId}`, description: 'Cancel job' },
    ],
  };

  console.log(JSON.stringify(result, dateReplacer, 2));
  process.exitCode = EXIT.OK;
}

/**
 * Poll the source's session index for a brand-new session created during this
 * send. wp/02 + wp/06: anchored to `beforeSendT` so we never return a session
 * that existed prior to spawn (cross-project leakage). Returns null when no
 * fresh session is detected after polling — the caller maps that to a
 * `NEW_SESSION_NOT_DETECTED` partial error.
 */
export async function detectNewSession(
  source: SessionSource,
  cwd: string,
  beforeSendT: number,
  deps: { listSessions?: typeof listSessions; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  const list = deps.listSessions ?? listSessions;
  const wait = deps.sleep ?? sleep;
  const attempts = 10;
  const delayMs = 200;
  const slopMs = 2_000; // tolerance for filesystem mtime / clock skew.
  const cutoff = beforeSendT - slopMs;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const entries = await list(source, 10);
      const t = Date.now();
      const candidates = entries.filter(
        (e) =>
          e.cwd === cwd &&
          e.updatedAt.getTime() >= cutoff &&
          t - e.updatedAt.getTime() < 30_000,
      );
      if (candidates.length === 1) return candidates[0].id;
      if (candidates.length > 1) {
        // Closest to spawn-completion-time wins. Stable in the common case
        // where only one session is fresh.
        candidates.sort(
          (a, b) =>
            Math.abs(a.updatedAt.getTime() - t) - Math.abs(b.updatedAt.getTime() - t),
        );
        return candidates[0].id;
      }
    } catch {
      // Keep polling; the session index can lag immediately after tool exit.
    }

    if (attempt < attempts - 1) {
      await wait(delayMs);
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SpawnResult {
  exitCode: number;
  stdoutTail: string[];
  stderrTail: string[];
}

/**
 * Run a child process to completion, mirroring its stdout+stderr to our stderr
 * (so JSON callers see live progress without polluting the stdout envelope)
 * and capturing the trailing 50 lines per stream for inclusion in error
 * envelopes. wp/03: both pipes are drained continuously to prevent OS buffer
 * deadlock; remaining buffered text is flushed before the promise settles.
 */
export function spawnAndWait(
  cmd: RunCommand,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // wp/03: explicit pipe stdio so the parent can drain stdout/stderr. With
    // pipes the child blocks once the OS buffer (~64KB) fills, so the data
    // listeners below MUST run for the lifetime of the child.
    const child = spawn(cmd.bin, cmd.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutTail = tapOutput(child.stdout);
    const stderrTail = tapOutput(child.stderr);
    let settled = false;

    const settle = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    child.once('error', (err) => {
      // Drain whatever the OS already delivered before the error fired so the
      // tail buffer carries diagnostic context for the caller.
      stdoutTail.flush();
      stderrTail.flush();
      settle(
        reject,
        new SessionReaderError(`Failed to spawn ${cmd.bin}: ${err.message}`, {
          code: 'SPAWN_ERROR',
          exitCode: EXIT.ERROR,
          detail: { tool: cmd.bin, error: err.message },
          suggestion: `Ensure ${cmd.bin} is installed and in PATH`,
        }),
      );
    });

    child.once('close', (code) => {
      stdoutTail.flush();
      stderrTail.flush();
      settle(resolve, {
        exitCode: code ?? 1,
        stdoutTail: stdoutTail.lines,
        stderrTail: stderrTail.lines,
      });
    });
  });
}

/**
 * Attach a data listener to a child stream, mirror chunks to stderr, and
 * keep a rolling buffer of the last 50 complete lines. Exported for unit
 * tests (wp/03 regression coverage).
 */
export function tapOutput(stream: NodeJS.ReadableStream): { lines: string[]; flush: () => void } {
  const lines: string[] = [];
  let buffered = '';

  const pushLine = (line: string): void => {
    lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (lines.length > 50) lines.shift();
  };

  stream.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
    buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const line of parts) pushLine(line);
  });

  return {
    lines,
    flush() {
      if (buffered.length === 0) return;
      pushLine(buffered);
      buffered = '';
    },
  };
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
