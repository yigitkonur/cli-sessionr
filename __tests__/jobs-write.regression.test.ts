/**
 * Phase 3 regression coverage for the wp/* write-path fixes:
 *   - wp/07 sidecar persistence is atomic (tmp + rename)
 *   - wp/09 finalizeJob does NOT mutate its input
 *
 * The wp/08 async-exit-code propagation already lands via the bash wrapper
 * (`exit_file=$1; …; printf "%s\n" "$code" > "$exit_file"`); finalizeJob
 * reads that sidecar at job-status time. The "covers wp/08" assertion below
 * checks the contract.
 *
 * wp/10 (SPAWN_FAILED vs CHILD_EXIT_NONZERO) is verified end-to-end in
 * send-dry-run.regression.test.ts via the dry-run path.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/types.js';

const DEAD_PID = 999_999;

async function loadJobsModule() {
  const home = mkdtempSync(join(tmpdir(), 'sessionr-jobs-write-test-'));
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
    id: 'wp-job-7',
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

describe('wp/07 — sidecar persistence is atomic', () => {
  it('writes through <sidecar>.tmp + rename (no partial file visible)', async () => {
    const { home, jobs } = await loadJobsModule();
    const job = makeJob({ status: 'completed', exit_code: 0 });

    jobs.updateJob(job);

    const dir = join(home, '.sessionreader', 'jobs');
    const files = readdirSync(dir);
    // No `.tmp` orphan should be left behind after a successful rename.
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Final file is intact and valid JSON.
    const final = JSON.parse(readFileSync(join(dir, `${job.id}.json`), 'utf-8'));
    expect(final).toMatchObject({
      id: job.id,
      status: 'completed',
      exit_code: 0,
    });
  });

  it('createJob also uses atomic persistence', async () => {
    const { home, jobs } = await loadJobsModule();
    const created = jobs.createJob({
      id: 'wp-job-7c',
      sessionId: null,
      source: 'codex',
      readBack: { source: 'codex' },
      cwd: '/tmp',
      message: 'hi',
      pid: DEAD_PID,
      messageCountBefore: 0,
      isNewSession: false,
      stdoutFile: '/tmp/x.out',
      stderrFile: '/tmp/x.err',
    });
    const dir = join(home, '.sessionreader', 'jobs');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(created.id).toBe('wp-job-7c');
    const final = JSON.parse(readFileSync(join(dir, 'wp-job-7c.json'), 'utf-8'));
    expect(final.status).toBe('running');
  });
});

describe('wp/09 — finalizeJob returns a NEW object, never mutates input', () => {
  it('input job is byte-for-byte equal after finalizeJob runs', async () => {
    const { home, jobs } = await loadJobsModule();
    mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
    const job = makeJob();
    writeFileSync(jobs.jobExitPath(job.id), '0\n');

    const snapshot = JSON.parse(JSON.stringify(job));
    const finalized = jobs.finalizeJob(job);

    expect(job).toEqual(snapshot);
    expect(finalized).not.toBe(job);
    expect(finalized.status).toBe('completed');
    expect(finalized.exit_code).toBe(0);
  });

  it('returns the SAME object instance for already-terminal jobs (no work)', async () => {
    const { jobs } = await loadJobsModule();
    const job = makeJob({ status: 'completed', exit_code: 0 });
    const finalized = jobs.finalizeJob(job);
    expect(finalized).toBe(job);
  });
});

describe('wp/08 — finalizeJob writes exit_code through to the sidecar', () => {
  it('after finalize, on-disk job.exit_code matches the wrapper sidecar', async () => {
    const { home, jobs } = await loadJobsModule();
    mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
    const job = makeJob();
    writeFileSync(jobs.jobExitPath(job.id), '42\n');

    jobs.finalizeJob(job);

    const dir = join(home, '.sessionreader', 'jobs');
    const persisted = JSON.parse(readFileSync(join(dir, `${job.id}.json`), 'utf-8'));
    expect(persisted.exit_code).toBe(42);
    expect(persisted.status).toBe('failed');
    expect(typeof persisted.completed_at).toBe('string');
  });

  it('flags exit_code_missing when the wrapper sidecar never landed', async () => {
    const { jobs } = await loadJobsModule();
    const finalized = jobs.finalizeJob(makeJob());
    expect(finalized.exit_code).toBe(-1);
    expect(finalized.last_error).toBe('exit_code_missing');
  });
});
