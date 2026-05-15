import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/types.js';

const DEAD_PID = 999_999;

async function loadJobsModule() {
  const home = mkdtempSync(join(tmpdir(), 'sessionr-jobs-test-'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    homedir: () => home,
  }));
  const jobs = await import('../src/jobs.js');
  return { home, jobs };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job123',
    session_id: null,
    source: 'codex',
    cwd: '/tmp',
    message: 'test',
    status: 'running',
    pid: DEAD_PID,
    exit_code: null,
    started_at: '2026-05-15T00:00:00.000Z',
    completed_at: null,
    message_count_before: 0,
    stdout_file: '/tmp/job.stdout',
    stderr_file: '/tmp/job.stderr',
    is_new_session: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock('node:os');
});

describe('jobs', () => {
  it('finalizes from exit sidecar instead of stderr content', async () => {
    const { home, jobs } = await loadJobsModule();
    const job = makeJob({
      stderr_file: join(home, 'warning.stderr'),
    });
    mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
    writeFileSync(job.stderr_file, 'warning\n');
    writeFileSync(jobs.jobExitPath(job.id), '0\n');

    const before = { ...job };
    const finalized = jobs.finalizeJob(job);

    expect(job).toEqual(before);
    expect(finalized).not.toBe(job);
    expect(finalized.status).toBe('completed');
    expect(finalized.exit_code).toBe(0);
  });

  it('uses non-zero sidecar exit codes for failed jobs', async () => {
    const { home, jobs } = await loadJobsModule();
    const job = makeJob();
    mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
    writeFileSync(jobs.jobExitPath(job.id), '137\n');

    const finalized = jobs.finalizeJob(job);

    expect(finalized.status).toBe('failed');
    expect(finalized.exit_code).toBe(137);
    expect(finalized.last_error).toBeNull();
  });

  it('marks dead jobs failed when the exit sidecar is missing', async () => {
    const { jobs } = await loadJobsModule();
    const finalized = jobs.finalizeJob(makeJob());

    expect(finalized.status).toBe('failed');
    expect(finalized.exit_code).toBe(-1);
    expect(finalized.last_error).toBe('exit_code_missing');
  });

  it('persists updates atomically through a temp rename', async () => {
    const { home, jobs } = await loadJobsModule();
    const job = makeJob({ status: 'completed', exit_code: 0 });

    jobs.updateJob(job);

    const path = join(home, '.sessionreader', 'jobs', `${job.id}.json`);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      id: job.id,
      status: 'completed',
      exit_code: 0,
    });
  });

  it('uses cancelled status for cancelled jobs', async () => {
    const { jobs } = await loadJobsModule();
    const cancelled = jobs.cancelJob(makeJob());

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.exit_code).toBe(130);
  });
});
