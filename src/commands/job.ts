import { cmdPrefix } from '../util/invocation.js';
import { readJob, listJobs, finalizeJob, cancelJob } from '../jobs.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { SessionReaderError, EXIT, exitCodeForError } from '../errors.js';
import type { Job, JobStatus, OutputFormat, V2Action, V2Meta } from '../types.js';

/**
 * wp/04 fix: derive the displayed job status from the persisted `exit_code`
 * sidecar, not from any stderr-grep heuristic. `finalizeJob` (in src/jobs.ts)
 * is responsible for reading the sidecar `.exit` file and persisting
 * `exit_code` to the job's `.json`. The command layer is responsible for
 * mapping that exit code into the displayed status the agent consumes:
 *
 *   exit_code === null  → 'running'   (job hasn't finished)
 *   exit_code === 0     → 'completed' (clean exit)
 *   exit_code === 130   → 'cancelled' (SIGINT — Ctrl-C or `kill -2`)
 *   exit_code > 0       → 'failed'    (non-zero exit other than SIGINT)
 *   exit_code === -1    → 'failed'    (sidecar missing → finalizeJob fallback)
 *
 * `finalizeJob` already writes status='completed' for code 0 and
 * status='failed' for everything else. We re-derive status here so that a job
 * externally SIGINT'd (where the user did NOT call `sessionr cancel`) still
 * surfaces as `cancelled` instead of `failed`, matching the JobStatus enum.
 *
 * We also surface `exit_code` inside the data block so consumers see the raw
 * signal even when status has been narrowed. The Job's persisted status stays
 * untouched — this is a display-time refinement.
 */
function refineJobStatus(job: Job): Job {
  if (job.exit_code === 130 && job.status !== 'cancelled') {
    return { ...job, status: 'cancelled' };
  }
  return job;
}

interface JobCommandOpts {
  output?: OutputFormat;
  status?: string;
  timeout?: number;
  interval?: number;
  timing?: boolean;
}

export async function jobStatusCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        errorClass: 'not_found',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: `${cmdPrefix()} jobs`,
      });
    }

    const finalized = refineJobStatus(finalizeJob(job));
    const actions = buildJobActions(finalized);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      emit(success(serializeJob(finalized), { actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(`Job ${finalized.id} → ${finalized.status}\n`);
    }
  } catch (err) {
    emitError(err, outputFormat, opts.timing, formatter, 'JOB_STATUS_FAILED');
  }
}

export async function jobWaitCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');
  const formatter = createFormatter({ output: opts.output, isTTY });
  const timeout = opts.timeout ?? 300;
  const interval = opts.interval ?? 2;

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        errorClass: 'not_found',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: `${cmdPrefix()} jobs`,
      });
    }

    const started = Date.now();
    const timeoutMs = timeout * 1000;
    const intervalMs = interval * 1000;

    let current = refineJobStatus(finalizeJob(job));

    while (current.status === 'running') {
      if (Date.now() - started > timeoutMs) {
        const nextTimeout = Math.min(timeout * 2, 3600);
        throw new SessionReaderError(`Job ${jobId} did not complete within ${timeout}s`, {
          code: 'JOB_TIMEOUT',
          errorClass: 'internal',
          exitCode: EXIT.ERROR,
          detail: { job_id: jobId, timeout_seconds: timeout },
          suggestion: `${cmdPrefix()} wait ${jobId} --timeout ${nextTimeout}`,
          retry: true,
        });
      }

      await sleep(intervalMs);
      const refreshed = readJob(jobId);
      if (!refreshed) break;
      current = refineJobStatus(finalizeJob(refreshed));
    }

    const actions = buildJobActions(current);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      emit(success(serializeJob(current), { actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(`Job ${current.id} → ${current.status}\n`);
    }
  } catch (err) {
    emitError(err, outputFormat, opts.timing, formatter, 'JOB_WAIT_FAILED');
  }
}

export async function jobCancelCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        errorClass: 'not_found',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: `${cmdPrefix()} jobs`,
      });
    }

    if (job.status !== 'running') {
      const actions = buildJobActions(job);
      const payload = {
        ...serializeJob(job),
        message: `Job already ${job.status}`,
      };
      if (outputFormat === 'json' || outputFormat === 'jsonl') {
        emit(success(payload, { actions }), {
          format: outputFormat,
          timing: opts.timing,
        });
      } else {
        process.stdout.write(`Job ${job.id} already ${job.status}\n`);
      }
      return;
    }

    const cancelled = cancelJob(job);
    const actions = buildJobActions(cancelled);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      emit(success(serializeJob(cancelled), { actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(`Job ${cancelled.id} → cancelled\n`);
    }
  } catch (err) {
    emitError(err, outputFormat, opts.timing, formatter, 'JOB_CANCEL_FAILED');
  }
}

export async function jobListCommand(opts: JobCommandOpts): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const statusFilter = opts.status as JobStatus | undefined;
    let jobs = listJobs(statusFilter);

    // Lazy-finalize running jobs and apply the wp/04 status refinement so
    // SIGINT-killed jobs (exit_code 130) surface as `cancelled` rather than
    // `failed` in the displayed listing.
    jobs = jobs.map((j) => refineJobStatus(j.status === 'running' ? finalizeJob(j) : j));
    const firstRunning = jobs.find((j) => j.status === 'running');
    const firstCompleted = jobs.find((j) => j.status === 'completed' && j.session_id);

    const prefix = cmdPrefix();
    const meta: V2Meta = {
      next_action: firstRunning
        ? {
            command: `${prefix} wait ${firstRunning.id}`,
            description: 'Wait for the first running job to complete',
          }
        : firstCompleted
          ? {
              command: `${prefix} read ${firstCompleted.session_id} --after ${firstCompleted.message_count_before}`,
              description: 'Read new messages from the most recent completed job',
            }
          : {
              command: `${prefix} send --new -s claude -f prompt.md`,
              description: 'Start a new async-capable session',
            },
    };

    const result = {
      jobs: jobs.map((j) => {
        const jobActions = buildJobActions(j);
        return {
          job_id: j.id,
          session_id: j.session_id,
          source: j.source,
          status: j.status,
          read_back: j.read_back,
          pid: j.pid,
          started_at: j.started_at,
          completed_at: j.completed_at,
          exit_code: j.exit_code,
          is_new_session: j.is_new_session,
          actions: jobActions,
        };
      }),
      total: jobs.length,
    };

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      emit(success(result, { meta }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(`${jobs.length} job(s)\n`);
      for (const j of jobs) {
        process.stdout.write(`  ${j.id}  ${j.status}  ${j.source}\n`);
      }
    }
  } catch (err) {
    emitError(err, outputFormat, opts.timing, formatter, 'JOBS_LIST_FAILED');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReadBackCommand(job: Job): string {
  const readBack = job.read_back ?? { source: job.source };
  const prefix = cmdPrefix();
  let command = `${prefix} read ${job.session_id} --after ${job.message_count_before} --source ${readBack.source}`;
  if (readBack.tokens !== undefined) command += ` --tokens ${readBack.tokens}`;
  if (readBack.preset) command += ` --preset ${readBack.preset}`;
  return command;
}

function buildJobActions(job: Job): V2Action[] {
  const prefix = cmdPrefix();
  const actions: V2Action[] = [];
  if (job.status === 'running') {
    actions.push(
      { command: `${prefix} wait ${job.id}`, description: 'Wait for completion' },
      { command: `${prefix} cancel ${job.id}`, description: 'Cancel job' },
    );
  } else if (job.status === 'completed' && job.session_id) {
    actions.push({
      command: buildReadBackCommand(job),
      description: 'Read new messages',
    });
  }
  return actions;
}

function serializeJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    session_id: job.session_id,
    source: job.source,
    status: job.status,
    read_back: job.read_back,
    cwd: job.cwd,
    pid: job.pid,
    exit_code: job.exit_code,
    started_at: job.started_at,
    completed_at: job.completed_at,
    message_count_before: job.message_count_before,
    stdout_file: job.stdout_file,
    stderr_file: job.stderr_file,
    is_new_session: job.is_new_session,
    ...(job.last_error !== undefined ? { last_error: job.last_error } : {}),
  };
}

function emitError(
  err: unknown,
  outputFormat: OutputFormat,
  timing: boolean | undefined,
  formatter: ReturnType<typeof createFormatter>,
  fallbackCode: string,
): void {
  if (outputFormat === 'json' || outputFormat === 'jsonl') {
    const isSre = err instanceof SessionReaderError;
    emit(
      failure({
        class: isSre ? err.class : 'internal',
        code: isSre ? err.code : fallbackCode,
        message: err instanceof Error ? err.message : String(err),
        ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
        ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
        retryable: isSre ? err.retry : false,
      }),
      { format: outputFormat, timing },
    );
  } else {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(formatter.error(error) + '\n');
  }
  process.exitCode = exitCodeForError(err);
}
