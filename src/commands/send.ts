import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { loadSession, listSessions } from '../discovery.js';
import { buildResumeCommand, buildNewCommand, canSend } from '../runners.js';
import { createJob, generateJobId } from '../jobs.js';
import { createFormatter } from '../output/formatter.js';
import { getPreset, getDefaultTokenBudget } from '../config.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { SessionReaderError, EXIT, exitCodeForError } from '../errors.js';
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
    const source = resolveSource(sessionId, opts.source, isNew);

    if (!canSend(source)) {
      throw new SessionReaderError('Zed AI threads are GUI-only — no CLI send support', {
        code: 'UNSUPPORTED_SOURCE',
        exitCode: EXIT.USAGE,
        detail: { source },
        suggestion: 'Use a CLI-based tool (claude, codex, gemini, etc.)',
      });
    }

    const cwd = opts.cwd ?? process.cwd();

    // Snapshot message count before send
    let messageCountBefore = 0;
    let resolvedSessionId = sessionId ?? null;

    if (!isNew && resolvedSessionId) {
      try {
        const session = await loadSession(resolvedSessionId, source);
        messageCountBefore = session.stats.totalMessages;
        resolvedSessionId = session.id; // resolve prefix to full ID
      } catch {
        // session might not exist yet if prefix doesn't match
      }
    }

    // Build the command
    const cmd = isNew
      ? buildNewCommand(source, opts.message, cwd)
      : buildResumeCommand(source, resolvedSessionId!, opts.message);

    if (opts.async) {
      await runAsync(cmd, resolvedSessionId, source, cwd, opts.message, messageCountBefore, isNew, formatter);
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
): SessionSource {
  if (sourceOpt) return sourceOpt as SessionSource;
  if (isNew) {
    throw new SessionReaderError('--source is required when creating a new session', {
      code: 'MISSING_SOURCE',
      exitCode: EXIT.USAGE,
      suggestion: 'sessionr send --new --source claude --message "..."',
    });
  }
  if (!sessionId) {
    throw new SessionReaderError('Either <session-id> or --new --source is required', {
      code: 'MISSING_SESSION',
      exitCode: EXIT.USAGE,
      suggestion: 'sessionr send <session-id> --message "..." OR --new --source claude',
    });
  }
  // Try to detect source from session ID by loading it
  return 'claude'; // will be overridden by actual source on load
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
  // Detect source from existing session if not explicitly provided
  let resolvedSource = source;
  if (!isNew && sessionId && !opts.source) {
    try {
      const session = await loadSession(sessionId);
      resolvedSource = session.source;
      const newCmd = buildResumeCommand(resolvedSource, session.id, opts.message);
      cmd = newCmd;
    } catch {
      // proceed with default
    }
  }

  const exitCode = await spawnAndWait(cmd, cwd);

  if (exitCode !== 0) {
    throw new SessionReaderError(`Tool exited with code ${exitCode}`, {
      code: 'TOOL_ERROR',
      exitCode: EXIT.ERROR,
      detail: { tool: cmd.bin, exit_code: exitCode, source: resolvedSource },
      suggestion: `Check ${cmd.bin} output for errors`,
    });
  }

  // Find the session and get new messages
  let finalSessionId = sessionId;
  if (isNew) {
    finalSessionId = await detectNewSession(resolvedSource, cwd);
  }

  if (!finalSessionId) {
    // Could not detect session — report success without messages
    const result = {
      api_version: 1,
      data: {
        status: 'completed',
        source: resolvedSource,
        exit_code: 0,
        is_new_session: isNew,
        message: 'Tool completed but session could not be detected',
      },
    };
    console.log(JSON.stringify(result, null, 2));
    return;
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
      command: `sessionr read ${session.id} --after ${messageCountBefore}`,
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
  message: string,
  messageCountBefore: number,
  isNew: boolean,
  formatter: ReturnType<typeof createFormatter>,
): Promise<void> {
  mkdirSync(JOBS_DIR, { recursive: true });

  const jobId = generateJobId();
  const stdoutFile = join(JOBS_DIR, `${jobId}.stdout`);
  const stderrFile = join(JOBS_DIR, `${jobId}.stderr`);

  const stdoutStream = createWriteStream(stdoutFile);
  const stderrStream = createWriteStream(stderrFile);

  const child = spawn(cmd.bin, cmd.args, {
    cwd,
    detached: true,
    stdio: ['ignore', stdoutStream, stderrStream],
  });

  child.unref();

  const job = createJob({
    id: jobId,
    sessionId,
    source,
    cwd,
    message,
    pid: child.pid!,
    messageCountBefore,
    isNewSession: isNew,
    stdoutFile,
    stderrFile,
  });

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
      { command: `sessionr job ${jobId}`, description: 'Check job status' },
      { command: `sessionr wait ${jobId}`, description: 'Wait for completion' },
      { command: `sessionr cancel ${jobId}`, description: 'Cancel job' },
    ],
  };

  console.log(JSON.stringify(result, dateReplacer, 2));
}

async function detectNewSession(
  source: SessionSource,
  cwd: string,
): Promise<string | null> {
  try {
    const entries = await listSessions(source, 5);
    // Return the most recent session from this source in this cwd
    const match = entries.find((e) => e.cwd === cwd);
    return match?.id ?? entries[0]?.id ?? null;
  } catch {
    return null;
  }
}

function spawnAndWait(
  cmd: { bin: string; args: string[] },
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.bin, cmd.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('error', (err) => {
      reject(
        new SessionReaderError(`Failed to spawn ${cmd.bin}: ${err.message}`, {
          code: 'SPAWN_ERROR',
          exitCode: EXIT.ERROR,
          detail: { tool: cmd.bin, error: err.message },
          suggestion: `Ensure ${cmd.bin} is installed and in PATH`,
        }),
      );
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
