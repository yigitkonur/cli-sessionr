import { readJob, listJobs, finalizeJob, cancelJob } from '../jobs.js';
import { createFormatter } from '../output/formatter.js';
import { SessionReaderError, EXIT, exitCodeForError } from '../errors.js';
import type { JobStatus, OutputFormat } from '../types.js';

interface JobCommandOpts {
  output?: OutputFormat;
  status?: string;
  timeout?: number;
  interval?: number;
}

export async function jobStatusCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: 'sessionr jobs',
      });
    }

    const finalized = finalizeJob(job);
    const actions: Array<{ command: string; description: string }> = [];

    if (finalized.status === 'completed' && finalized.session_id) {
      actions.push({
        command: `sessionr read ${finalized.session_id} --after ${finalized.message_count_before}`,
        description: 'Read new messages',
      });
    }
    if (finalized.status === 'running') {
      actions.push(
        { command: `sessionr wait ${jobId}`, description: 'Wait for completion' },
        { command: `sessionr cancel ${jobId}`, description: 'Cancel job' },
      );
    }

    const result = {
      api_version: 1,
      data: { ...finalized },
      actions,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}

export async function jobWaitCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });
  const timeout = opts.timeout ?? 300;
  const interval = opts.interval ?? 2;

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: 'sessionr jobs',
      });
    }

    const started = Date.now();
    const timeoutMs = timeout * 1000;
    const intervalMs = interval * 1000;

    let current = finalizeJob(job);

    while (current.status === 'running') {
      if (Date.now() - started > timeoutMs) {
        throw new SessionReaderError(`Job ${jobId} did not complete within ${timeout}s`, {
          code: 'JOB_TIMEOUT',
          exitCode: EXIT.ERROR,
          detail: { job_id: jobId, timeout_seconds: timeout },
          suggestion: `sessionr wait ${jobId} --timeout ${timeout * 2}`,
          retry: true,
        });
      }

      await sleep(intervalMs);
      const refreshed = readJob(jobId);
      if (!refreshed) break;
      current = finalizeJob(refreshed);
    }

    const actions: Array<{ command: string; description: string }> = [];
    if (current.status === 'completed' && current.session_id) {
      actions.push({
        command: `sessionr read ${current.session_id} --after ${current.message_count_before}`,
        description: 'Read new messages',
      });
    }

    const result = {
      api_version: 1,
      data: { ...current },
      actions,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}

export async function jobCancelCommand(
  jobId: string,
  opts: JobCommandOpts,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const job = readJob(jobId);
    if (!job) {
      throw new SessionReaderError(`Job not found: ${jobId}`, {
        code: 'JOB_NOT_FOUND',
        exitCode: EXIT.NOT_FOUND,
        detail: { job_id: jobId },
        suggestion: 'sessionr jobs',
      });
    }

    if (job.status !== 'running') {
      const result = {
        api_version: 1,
        data: { ...job, message: `Job already ${job.status}` },
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const cancelled = cancelJob(job);

    const result = {
      api_version: 1,
      data: { ...cancelled },
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}

export async function jobListCommand(opts: JobCommandOpts): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({ output: opts.output, isTTY });

  try {
    const statusFilter = opts.status as JobStatus | undefined;
    let jobs = listJobs(statusFilter);

    // Lazy-finalize running jobs
    jobs = jobs.map((j) => (j.status === 'running' ? finalizeJob(j) : j));

    const result = {
      api_version: 1,
      jobs: jobs.map((j) => {
        const jobActions: Array<{ command: string; description: string }> = [];
        if (j.status === 'running') {
          jobActions.push(
            { command: `sessionr wait ${j.id}`, description: 'Wait for completion' },
            { command: `sessionr cancel ${j.id}`, description: 'Cancel job' },
          );
        } else if (j.status === 'completed' && j.session_id) {
          jobActions.push(
            { command: `sessionr read ${j.session_id} --after ${j.message_count_before}`, description: 'Read new messages' },
          );
        }
        return {
          job_id: j.id,
          session_id: j.session_id,
          source: j.source,
          status: j.status,
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

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
