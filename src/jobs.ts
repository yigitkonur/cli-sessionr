import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Job, JobStatus, SessionSource } from './types.js';

const JOBS_DIR = join(homedir(), '.sessionreader', 'jobs');
const LOCK_STALE_MS = 30_000;

function ensureDir(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

export function jobExitPath(id: string): string {
  return `${jobPath(id)}.exit`;
}

function jobLockPath(id: string): string {
  return `${jobPath(id)}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withJobLock<T>(id: string, fn: () => T): T {
  ensureDir();
  const lockPath = jobLockPath(id);
  let fd: number | null = null;

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // Another process may have released the lock.
      }

      sleepSync(10);
    }
  }

  if (fd === null) {
    throw new Error(`Timed out acquiring job lock for ${id}`);
  }

  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort; a stale lock is cleaned up on the next writer.
    }
  }
}

function writeJobAtomic(job: Job): void {
  const path = jobPath(job.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, path);
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
  withJobLock(job.id, () => writeJobAtomic(job));
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
  withJobLock(job.id, () => writeJobAtomic(job));
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

  let exitCode = -1;
  let lastError: string | null = null;
  try {
    const raw = readFileSync(jobExitPath(job.id), 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      exitCode = parsed;
    } else {
      lastError = 'exit_code_missing';
    }
  } catch {
    lastError = 'exit_code_missing';
  }

  const finalized: Job = {
    ...job,
    status: exitCode === 0 ? 'completed' : 'failed',
    completed_at: new Date().toISOString(),
    exit_code: exitCode,
    last_error: lastError,
  };

  updateJob(finalized);
  return finalized;
}

export function cancelJob(job: Job): Job {
  if (job.status !== 'running') return job;

  try {
    process.kill(-job.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }

  const cancelled: Job = {
    ...job,
    status: 'cancelled',
    exit_code: 130, // SIGTERM convention
    completed_at: new Date().toISOString(),
    last_error: null,
  };

  updateJob(cancelled);
  return cancelled;
}
