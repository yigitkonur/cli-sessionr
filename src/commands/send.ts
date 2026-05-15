import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { loadSession, listSessions } from '../discovery.js';
import { buildResumeCommand, buildNewCommand, canSend } from '../runners.js';
import { createJob, generateJobId, jobExitPath } from '../jobs.js';
import { createFormatter } from '../output/formatter.js';
import { getPreset, getDefaultTokenBudget } from '../config.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { SessionReaderError, EXIT, exitCodeForError } from '../errors.js';
import { resolveSourceAlias } from '../parsers/registry.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, SendOptions, OutputFormat, SliceMeta } from '../types.js';

const JOBS_DIR = join(homedir(), '.sessionreader', 'jobs');

export async function sendCommand(
  sessionId: string | undefined,
  opts: SendOptions,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
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
        suggestion: 'Verify the session exists with: sessionr list --output json',
      });
    }

    if (!canSend(source)) {
      throw new SessionReaderError('Zed AI threads are GUI-only — no CLI send support', {
        code: 'UNSUPPORTED_SOURCE',
        exitCode: EXIT.USAGE,
        detail: { source },
        suggestion: 'Use a CLI-based tool (claude, codex, gemini, etc.)',
      });
    }

    // Build the command
    const cmd = isNew
      ? buildNewCommand(source, opts.message, cwd)
      : buildResumeCommand(source, resolvedSessionId!, opts.message);

    if (opts.async) {
      await runAsync(cmd, resolvedSessionId, source, cwd, opts, messageCountBefore, isNew, formatter);
    } else {
      await runSync(cmd, resolvedSessionId, source, cwd, opts, messageCountBefore, isNew, formatter);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
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
      suggestion: 'sessionr send --new --source claude -f prompt.md',
    });
  }
  if (!sessionId) {
    throw new SessionReaderError('Either <session-id> or --new --source is required', {
      code: 'MISSING_SESSION',
      exitCode: EXIT.USAGE,
      suggestion: 'sessionr send <session-id> -f prompt.md OR --new --source claude -f prompt.md',
    });
  }
  // Source will be auto-detected from session metadata before command build.
  return undefined;
}

async function runSync(
  cmd: { bin: string; args: string[] },
  sessionId: string | null,
  source: SessionSource,
  cwd: string,
  opts: SendOptions,
  messageCountBefore: number,
  isNew: boolean,
  formatter: ReturnType<typeof createFormatter>,
): Promise<void> {
  const resolvedSource = source;

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
    finalSessionId = await detectNewSession(resolvedSource, cwd);
  }

  if (!finalSessionId) {
    if (isNew) {
      throw new SessionReaderError('Tool completed but new session was not detected in cwd', {
        code: 'NEW_SESSION_NOT_DETECTED',
        exitCode: EXIT.PARTIAL,
        detail: { source: resolvedSource, cwd },
        suggestion: `sessionr list --cwd current --source ${resolvedSource} -n 5`,
        retry: true,
      });
    }

    throw new SessionReaderError('Session could not be determined after send', {
      code: 'SESSION_NOT_FOUND',
      exitCode: EXIT.NOT_FOUND,
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

  envelope.messages = outputMessages.map((m) => ({
    index: m.index,
    role: m.role,
    timestamp: m.timestamp,
    content: m.content,
    blocks: m.blocks,
  }));

  envelope.actions = [
    {
      command: `${cmdPrefix()} read ${session.id} --after ${messageCountBefore}`,
      description: 'Re-read new messages',
    },
  ];

  console.log(JSON.stringify(envelope, dateReplacer, 2));
}

async function runAsync(
  cmd: { bin: string; args: string[] },
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
      message: opts.message,
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

async function detectNewSession(
  source: SessionSource,
  cwd: string,
): Promise<string | null> {
  const attempts = 10;
  const delayMs = 200;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const entries = await listSessions(source, 10);
      const now = Date.now();
      const match = entries.find(
        (e) => e.cwd === cwd && now - e.updatedAt.getTime() < 30_000,
      );
      if (match) return match.id;
    } catch {
      // Keep polling; the session index can lag immediately after tool exit.
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
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

export function spawnAndWait(
  cmd: { bin: string; args: string[] },
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
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

function tapOutput(stream: NodeJS.ReadableStream): { lines: string[]; flush: () => void } {
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
