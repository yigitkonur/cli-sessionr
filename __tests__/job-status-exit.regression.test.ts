import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/types.js';

/**
 * wp/04 regression coverage.
 *
 * `sessionr job <id>` (and `wait <id>` / `jobs`) must derive the displayed
 * status from the persisted `exit_code` sidecar, never from grep'ing stderr.
 *
 * Mapping locked here:
 *   exit_code === null  → 'running'
 *   exit_code === 0     → 'completed'
 *   exit_code === 130   → 'cancelled'   (SIGINT, including externally killed)
 *   exit_code  >  0     → 'failed'
 *   exit_code === -1    → 'failed'      (sidecar missing fallback)
 *
 * `finalizeJob` writes status='failed' for exit code 130, so the command
 * layer's `refineJobStatus` is what surfaces SIGINT-killed jobs as
 * 'cancelled' for the agent. This test locks both layers.
 */

const DEAD_PID = 999_999;

async function loadModules() {
  const home = mkdtempSync(join(tmpdir(), 'sessionr-job-cmd-test-'));
  mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    homedir: () => home,
  }));
  const jobs = await import('../src/jobs.js');
  const cmd = await import('../src/commands/job.js');
  return { home, jobs, cmd };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'jobtest',
    session_id: 'sess-1',
    source: 'codex',
    read_back: { source: 'codex' },
    cwd: '/tmp',
    message: 'test',
    status: 'running',
    pid: DEAD_PID,
    exit_code: null,
    started_at: '2026-05-15T00:00:00.000Z',
    completed_at: null,
    message_count_before: 0,
    stdout_file: '/tmp/jobtest.stdout',
    stderr_file: '/tmp/jobtest.stderr',
    is_new_session: true,
    ...overrides,
  } as Job;
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return { chunks, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.doUnmock('node:os');
  vi.restoreAllMocks();
});

describe('job command derives status from persisted exit_code (wp/04)', () => {
  let stdout: ReturnType<typeof captureStdout>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    stdout = captureStdout();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdout.restore();
    process.exitCode = originalExitCode;
  });

  /** Extract the result block from the v2 success envelope emit() writes. */
  function parseEnvelope(): {
    ok: boolean;
    schema_version: string;
    result: Record<string, unknown>;
    [k: string]: unknown;
  } {
    expect(stdout.chunks.length).toBeGreaterThan(0);
    return JSON.parse(stdout.chunks.join(''));
  }

  it('exit_code 0 → status: completed (clean exit, no stderr-grep)', async () => {
    const { jobs, cmd } = await loadModules();
    const job = makeJob({ id: 'okexit' });
    jobs.updateJob(job);
    // Even with stderr noise, exit code drives the status.
    writeFileSync(job.stderr_file, 'deprecation warning: blah\n');
    writeFileSync(jobs.jobExitPath(job.id), '0\n');

    await cmd.jobStatusCommand('okexit', { output: 'json' });

    const env = parseEnvelope();
    expect(env.ok).toBe(true);
    expect(env.result.status).toBe('completed');
    expect(env.result.exit_code).toBe(0);
  });

  it('exit_code 137 → status: failed (no false-positive completion)', async () => {
    const { jobs, cmd } = await loadModules();
    const job = makeJob({ id: 'sigkill' });
    jobs.updateJob(job);
    // Empty stderr — the old heuristic would have called this "completed".
    writeFileSync(job.stderr_file, '');
    writeFileSync(jobs.jobExitPath(job.id), '137\n');

    await cmd.jobStatusCommand('sigkill', { output: 'json' });

    const env = parseEnvelope();
    expect(env.result.status).toBe('failed');
    expect(env.result.exit_code).toBe(137);
  });

  it('exit_code 130 → status: cancelled (SIGINT mapping, even when not via sessionr cancel)', async () => {
    const { jobs, cmd } = await loadModules();
    const job = makeJob({ id: 'sigint' });
    jobs.updateJob(job);
    writeFileSync(jobs.jobExitPath(job.id), '130\n');

    await cmd.jobStatusCommand('sigint', { output: 'json' });

    const env = parseEnvelope();
    expect(env.result.status).toBe('cancelled');
    expect(env.result.exit_code).toBe(130);
  });

  it('exit_code missing → status: failed, last_error: exit_code_missing', async () => {
    const { jobs, cmd } = await loadModules();
    const job = makeJob({ id: 'nosidecar' });
    jobs.updateJob(job);
    // No sidecar written; process is dead. finalizeJob falls back to -1.

    await cmd.jobStatusCommand('nosidecar', { output: 'json' });

    const env = parseEnvelope();
    expect(env.result.status).toBe('failed');
    expect(env.result.exit_code).toBe(-1);
    expect(env.result.last_error).toBe('exit_code_missing');
  });

  it('exit_code 0 + stderr content → still completed (kills the stderr-presence heuristic)', async () => {
    const { jobs, cmd } = await loadModules();
    const job = makeJob({ id: 'warnings' });
    jobs.updateJob(job);
    // Heavy stderr noise — would have flipped the legacy heuristic to "failed".
    writeFileSync(
      job.stderr_file,
      'Warning: deprecated API\nNotice: cache miss\nInfo: 42 tokens\n',
    );
    writeFileSync(jobs.jobExitPath(job.id), '0\n');

    await cmd.jobStatusCommand('warnings', { output: 'json' });

    const env = parseEnvelope();
    expect(env.result.status).toBe('completed');
    expect(env.result.exit_code).toBe(0);
  });

  it('jobs list applies the same exit_code → status mapping (incl. cancelled)', async () => {
    const { jobs, cmd } = await loadModules();
    const ok = makeJob({ id: 'list-ok', started_at: '2026-05-15T00:00:00.000Z' });
    const cancelled = makeJob({ id: 'list-cancel', started_at: '2026-05-15T00:00:01.000Z' });
    const failed = makeJob({ id: 'list-fail', started_at: '2026-05-15T00:00:02.000Z' });
    jobs.updateJob(ok);
    jobs.updateJob(cancelled);
    jobs.updateJob(failed);
    writeFileSync(jobs.jobExitPath('list-ok'), '0\n');
    writeFileSync(jobs.jobExitPath('list-cancel'), '130\n');
    writeFileSync(jobs.jobExitPath('list-fail'), '1\n');

    await cmd.jobListCommand({ output: 'json' });

    const env = parseEnvelope();
    const list = (env.result as { jobs: Array<{ job_id: string; status: string; exit_code: number }> }).jobs;
    expect(list).toBeDefined();
    const byId = new Map(list.map((j) => [j.job_id, { status: j.status, exit_code: j.exit_code }]));
    expect(byId.get('list-ok')).toEqual({ status: 'completed', exit_code: 0 });
    expect(byId.get('list-cancel')).toEqual({ status: 'cancelled', exit_code: 130 });
    expect(byId.get('list-fail')).toEqual({ status: 'failed', exit_code: 1 });
  });
});
