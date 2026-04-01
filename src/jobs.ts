import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Job, JobStatus, SessionSource } from './types.js';

const JOBS_DIR = join(homedir(), '.sessionreader', 'jobs');

function ensureDir(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

export function generateJobId(): string {
  return randomBytes(4).toString('hex');
}

export function createJob(opts: {
  id: string;
  sessionId: string | null;
  source: SessionSource;
  cwd: string;
  message: string;
  pid: number;
  messageCountBefore: number;
  isNewSession: boolean;
  stdoutFile: string;
  stderrFile: string;
}): Job {
  ensureDir();
  const job: Job = {
    id: opts.id,
    session_id: opts.sessionId,
    source: opts.source,
    cwd: opts.cwd,
    message: opts.message,
    status: 'running',
    pid: opts.pid,
    exit_code: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    message_count_before: opts.messageCountBefore,
    stdout_file: opts.stdoutFile,
    stderr_file: opts.stderrFile,
    is_new_session: opts.isNewSession,
  };
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

export function readJob(id: string): Job | null {
  try {
    const data = readFileSync(jobPath(id), 'utf-8');
    return JSON.parse(data) as Job;
  } catch {
    return null;
  }
}

export function updateJob(job: Job): void {
  ensureDir();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

export function listJobs(statusFilter?: JobStatus): Job[] {
  ensureDir();
  const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  const jobs: Job[] = [];
  for (const f of files) {
    try {
      const data = readFileSync(join(JOBS_DIR, f), 'utf-8');
      const job = JSON.parse(data) as Job;
      if (!statusFilter || job.status === statusFilter) {
        jobs.push(job);
      }
    } catch {
      // skip corrupt files
    }
  }
  jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return jobs;
}

export function deleteJob(id: string): boolean {
  try {
    unlinkSync(jobPath(id));
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function finalizeJob(job: Job): Job {
  if (job.status !== 'running') return job;
  if (isPidAlive(job.pid)) return job;

  // PID is dead — finalize
  job.status = 'completed';
  job.completed_at = new Date().toISOString();

  // Try to read exit code from stderr hints, otherwise assume success
  try {
    const stderr = readFileSync(job.stderr_file, 'utf-8').trim();
    if (stderr.length > 0) {
      job.status = 'failed';
      job.exit_code = 1;
    } else {
      job.exit_code = 0;
    }
  } catch {
    job.exit_code = 0;
  }

  updateJob(job);
  return job;
}

export function cancelJob(job: Job): Job {
  if (job.status !== 'running') return job;

  try {
    process.kill(job.pid, 'SIGTERM');
  } catch {
    // already dead
  }

  job.status = 'failed';
  job.exit_code = 130; // SIGTERM convention
  job.completed_at = new Date().toISOString();
  updateJob(job);
  return job;
}
