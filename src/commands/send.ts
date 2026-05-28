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
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import type { SessionSource, SendOptions, OutputFormat, SliceMeta } from '../types.js';

const JOBS_DIR = join(homedir(), '.sessionreader', 'jobs');

/**
 * ds/03 — `--detect-timeout-ms` ceiling for detectNewSession's slop window.
 * Default 2000 ms. The slop tolerates filesystem mtime drift (NFS, slow
 * disks) and clock skew between the agent host and the tool's writer.
 *
 * TODO(v3.1): make detect-timeout-ms configurable via env
 * SESSIONR_DETECT_TIMEOUT_MS so CI environments with slow filesystems can
 * tune it without re-shipping.
 */
const DEFAULT_DETECT_TIMEOUT_MS = 2_000;

/**
 * ds/02 — default cap on how many NEW sessions a single command can spawn
 * if it loops. Today `send` only spawns one child per invocation, but the
 * cap is shipped so a future batch/auto-retry mode can't fan out fifty
 * brand-new sessions by accident. `--max-new-per-run` overrides at run
 * time; setting it to 0 disables new sessions entirely.
 */
const DEFAULT_MAX_NEW_PER_RUN = 1;

/**
 * Phase 3 extension fields for SendOptions. Kept local so we don't touch
 * src/types.ts (outside the allow-list). cli.ts populates these via type
 * assertion when it wires the new CLI flags through.
 */
type SendOptionsX = SendOptions & {
  dryRun?: boolean;
  maxNewPerRun?: number;
  detectTimeoutMs?: number;
};

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
  opts: SendOptionsX,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  // Creating the formatter here is the validation chokepoint for --output
  // (oc/05); it throws INVALID_OUTPUT for unknown formats before any work.
  // The instance itself is not used by runSync/runAsync — those write the
  // v2 envelope through emit() directly. Phase 2 review carry-forward: the
  // `formatter` parameter passed to runSync/runAsync was dead weight and is
  // now removed.
  createFormatter({ output: opts.output, isTTY });
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

    // ds/02: enforce --max-new-per-run BEFORE building the command so a
    // configured cap of 0 (or a misconfigured loop) cannot fan out new
    // sessions even when --new is passed. `send` itself only spawns once
    // per invocation; this guard protects future batch/retry callers.
    const maxNew = opts.maxNewPerRun ?? DEFAULT_MAX_NEW_PER_RUN;
    if (isNew && maxNew <= 0) {
      throw new SessionReaderError(
        `--max-new-per-run is ${maxNew}; refusing to create a new session.`,
        {
          code: 'MAX_NEW_EXCEEDED',
          exitCode: EXIT.USAGE,
          errorClass: 'validation',
          detail: { max_new_per_run: maxNew },
          suggestion: 'sessionr send <existing-id> -m "..."  OR  --max-new-per-run 1',
        },
      );
    }

    // Build the command (with safety guard against malformed RunCommand shapes).
    const cmd = isNew
      ? buildNewCommand(source, message, cwd)
      : buildResumeCommand(source, resolvedSessionId!, message);
    assertSpawnable(cmd);

    // ds/02: --dry-run short-circuits BEFORE any spawn so an agent can probe
    // the exact `{bin, args, cwd}` it would launch without side effects.
    // The result is a normal v2 success envelope with `result.dry_run: true`.
    if (opts.dryRun) {
      // L8 (adversarial review): forward --timing here too (was omitted).
      emit(
        success({
          dry_run: true,
          would_spawn: { bin: cmd.bin, args: cmd.args, cwd },
          source,
          session_id: resolvedSessionId,
          is_new_session: isNew,
          max_new_per_run: maxNew,
        }),
        { format, timing: opts.timing },
      );
      return;
    }

    if (opts.async) {
      await runAsync(cmd, resolvedSessionId, source, cwd, { ...opts, message }, messageCountBefore, isNew);
    } else {
      await runSync(cmd, resolvedSessionId, source, cwd, { ...opts, message }, messageCountBefore, isNew);
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
  opts: SendOptionsX,
  messageCountBefore: number,
  isNew: boolean,
): Promise<void> {
  const resolvedSource = source;

  // wp/02 + wp/06: anchor the detect-new-session window to a timestamp captured
  // BEFORE the child runs so we never attach to a session created earlier by
  // another tool.
  // TODO(v3.1): make detect-timeout-ms configurable via env
  // SESSIONR_DETECT_TIMEOUT_MS (today only --detect-timeout-ms is honoured).
  const beforeSendT = Date.now();
  const detectTimeoutMs = opts.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;

  const result = await spawnAndWait(cmd, cwd);

  if (result.exitCode !== 0) {
    // wp/10: distinguish "binary ran and failed" (CHILD_EXIT_NONZERO) from
    // "binary never launched" (SPAWN_FAILED, raised in spawnAndWait below).
    // The two map to different agent reactions: the former is a retry-after-
    // fix; the latter is a doctor/install hint.
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

    throw new SessionReaderError(`Tool ${cmd.bin} exited with code ${result.exitCode}`, {
      code: 'CHILD_EXIT_NONZERO',
      exitCode: EXIT.ERROR,
      errorClass: 'internal',
      detail,
      suggestion: `Check ${cmd.bin} output for errors (see detail.stderr_tail)`,
    });
  }

  // Find the session and get new messages
  let finalSessionId = sessionId;
  if (isNew) {
    finalSessionId = await detectNewSession(resolvedSource, cwd, beforeSendT, {
      timeoutMs: detectTimeoutMs,
    });
  }

  if (!finalSessionId) {
    if (isNew) {
      throw new SessionReaderError('Tool completed but new session was not detected in cwd', {
        code: 'NEW_SESSION_NOT_DETECTED',
        exitCode: EXIT.PARTIAL,
        errorClass: 'partial',
        detail: {
          source: resolvedSource,
          cwd,
          detect_timeout_ms: detectTimeoutMs,
          hint: 'session may take a moment to flush; try --detect-timeout-ms 5000',
        },
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
    const sliceResult = sliceByTokenBudget(
      newMessages,
      tokenBudget,
      session.id,
      session.source,
      'tail',
    );
    outputMessages = sliceResult.messages;
    meta = sliceResult.meta;
  }

  // Resolve preset so it participates in validation (er/05) AND so the
  // serializeMessage call below can pick the right content/blocks channel
  // (oc/13). Without the preset hand-off, every text-only message paid for
  // a redundant `blocks` payload in the sync response.
  const preset = getPreset(opts.preset ?? 'standard');
  const from = newMessages.length > 0 ? newMessages[0].index : 0;
  const to = newMessages.length > 0 ? newMessages[newMessages.length - 1].index : 0;

  // Send-specific pagination/meta. Reuse the slice meta when present
  // (large responses) and always stamp the send counters on top.
  const sendMeta: Record<string, unknown> = {
    ...(meta ?? {
      total_messages: session.stats.totalMessages,
      total_tokens_estimate: estimateSessionTokens(session.messages),
      returned_tokens_estimate: estimateSessionTokens(outputMessages),
      range: { from, to },
    }),
    message_count_before: messageCountBefore,
    message_count_after: session.stats.totalMessages,
    new_messages: newMessages.length,
    is_new_session: isNew,
  };

  // oc/13: route through serializeMessage with the resolved preset so text-only
  // messages don't carry a redundant `blocks` payload. Rich messages emit ONE
  // channel (content vs blocks) based on the user's preset choice; without
  // this every send-sync response paid the dual-channel cost flagged in oc/12.
  const sendResult = {
    session_id: session.id,
    source: session.source,
    is_new_session: isNew,
    message_count_before: messageCountBefore,
    message_count_after: session.stats.totalMessages,
    new_messages: newMessages.length,
    messages: outputMessages.map((m) => serializeMessage(m, { preset: preset.name })),
  };

  const actions = [
    {
      command: `${cmdPrefix()} read ${session.id} --after ${messageCountBefore}`,
      description: 'Re-read new messages',
    },
  ];

  // oc/07 + oc/08: send sync now emits the canonical v2 envelope via emit()
  // like every other command. Previously it hand-wrote a legacy meta+messages
  // shape on console.log, bypassing the contract — caught in v3 review.
  const format: OutputFormat = opts.output ?? (process.stdout.isTTY ? 'text' : 'json');
  emit(success(sendResult, { meta: sendMeta, actions }), { format, timing: opts.timing });
}

async function runAsync(
  cmd: RunCommand,
  sessionId: string | null,
  source: SessionSource,
  cwd: string,
  opts: SendOptionsX,
  messageCountBefore: number,
  isNew: boolean,
): Promise<void> {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch (err) {
    throw new SessionReaderError(`Failed to prepare async jobs directory: ${(err as Error).message}`, {
      code: 'ASYNC_SETUP_ERROR',
      exitCode: EXIT.ERROR,
      errorClass: 'internal',
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
    // wp/10: this catch fires when bash itself (the wrapper) fails to launch
    // — usually missing bash or sandbox restriction. The tool binary may
    // also be missing (caught later via spawn 'error' event in spawnAndWait).
    throw new SessionReaderError(`Failed to start async job for ${cmd.bin}: ${(err as Error).message}`, {
      code: 'SPAWN_FAILED',
      exitCode: EXIT.ERROR,
      errorClass: 'internal',
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
      code: 'SPAWN_FAILED',
      exitCode: EXIT.ERROR,
      errorClass: 'internal',
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
      errorClass: 'internal',
      detail: { job_id: jobId, error: (err as Error).message },
      suggestion: 'Ensure the jobs directory is writable',
      cause: err,
    });
  }

  child.unref();

  // oc/07 + oc/08: async send now emits the canonical v2 envelope (dropping
  // the old `data` wrapper) via emit() like every other command. Previously it
  // hand-wrote a legacy wrapped shape on console.log — caught in v3 review.
  const result = {
    job_id: job.id,
    session_id: sessionId,
    source,
    status: 'running',
    pid: child.pid,
    started_at: job.started_at,
    is_new_session: isNew,
    message_count_before: messageCountBefore,
  };
  const actions = [
    { command: `${cmdPrefix()} job ${jobId}`, description: 'Check job status' },
    { command: `${cmdPrefix()} wait ${jobId}`, description: 'Wait for completion' },
    { command: `${cmdPrefix()} cancel ${jobId}`, description: 'Cancel job' },
  ];

  const format: OutputFormat = opts.output ?? (process.stdout.isTTY ? 'text' : 'json');
  emit(success(result, { actions }), { format, timing: opts.timing });
  process.exitCode = EXIT.OK;
}

/**
 * Poll the source's session index for a brand-new session created during this
 * send. wp/02 + wp/06: anchored to `beforeSendT` so we never return a session
 * that existed prior to spawn (cross-project leakage). Returns null when no
 * fresh session is detected after polling — the caller maps that to a
 * `NEW_SESSION_NOT_DETECTED` partial error.
 *
 * ds/03 — the slop tolerance is configurable via `timeoutMs` (default 2000
 * ms). Slow filesystems (NFS) or clock skew can push session mtime outside
 * the default window, so agents can raise the budget per-call.
 */
export async function detectNewSession(
  source: SessionSource,
  cwd: string,
  beforeSendT: number,
  deps: {
    listSessions?: typeof listSessions;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const list = deps.listSessions ?? listSessions;
  const wait = deps.sleep ?? sleep;
  const attempts = 10;
  const delayMs = 200;
  // TODO(v3.1): also honour env SESSIONR_DETECT_TIMEOUT_MS as the default.
  const slopMs = deps.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
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
      // wp/10: spawn 'error' fires ONLY when the OS rejects exec (binary
      // missing, EACCES, ENOENT). The child binary running and exiting
      // non-zero goes through the 'close' branch below as CHILD_EXIT_NONZERO.
      stdoutTail.flush();
      stderrTail.flush();
      settle(
        reject,
        new SessionReaderError(`Failed to spawn ${cmd.bin}: ${err.message}`, {
          code: 'SPAWN_FAILED',
          exitCode: EXIT.ERROR,
          errorClass: 'internal',
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
