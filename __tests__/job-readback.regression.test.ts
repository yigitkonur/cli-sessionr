// it/04 regression — when send --async records a job, the job sidecar
// must carry the original --source/--tokens/--preset so wait/job/cancel
// responses can echo them back. Without this the next_action commands
// drop the agent's original render intent.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/types.js';

const DEAD_PID = 999_999;

async function loadModules(): Promise<{
  home: string;
  jobs: typeof import('../src/jobs.js');
  jobCmd: typeof import('../src/commands/job.js');
}> {
  const home = mkdtempSync(join(tmpdir(), 'sessionr-readback-test-'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    homedir: () => home,
  }));
  const jobs = await import('../src/jobs.js');
  const jobCmd = await import('../src/commands/job.js');
  return { home, jobs, jobCmd };
}

function seedJob(home: string, override: Partial<Job> = {}): Job {
  mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });
  const job: Job = {
    id: 'jobreadback',
    session_id: 'sess-target',
    source: 'claude',
    read_back: { source: 'claude', tokens: 4000, preset: 'verbose' },
    cwd: '/tmp',
    message: 'hi',
    status: 'completed',
    pid: DEAD_PID,
    exit_code: 0,
    started_at: '2026-05-15T00:00:00.000Z',
    completed_at: '2026-05-15T00:01:00.000Z',
    message_count_before: 7,
    stdout_file: '/tmp/job.stdout',
    stderr_file: '/tmp/job.stderr',
    is_new_session: false,
    ...override,
  };
  writeFileSync(
    join(home, '.sessionreader', 'jobs', `${job.id}.json`),
    JSON.stringify(job, null, 2),
  );
  return job;
}

// Agent A's job.ts migration writes through emit() → process.stdout.write.
// Spy on the lower-level surface and reassemble the buffer for parsing.
function makeStdoutCapture(): { write: ReturnType<typeof vi.spyOn>; payload: () => string } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'));
    return true;
  });
  return { write: spy, payload: () => chunks.join('') };
}

describe('job read_back persistence (it/04)', () => {
  let stdout: { write: ReturnType<typeof vi.spyOn>; payload: () => string };

  beforeEach(() => {
    process.exitCode = undefined;
    stdout = makeStdoutCapture();
  });

  afterEach(() => {
    stdout.write.mockRestore();
    vi.doUnmock('node:os');
    process.exitCode = undefined;
  });

  function parseEnvelope(): {
    ok?: boolean;
    schema_version?: string;
    result?: Record<string, unknown>;
    data?: Record<string, unknown>;
    actions?: Array<{ command: string }>;
  } {
    return JSON.parse(stdout.payload().trim());
  }

  // Resolve the job payload from either v2 envelope (.result) or v1 (.data).
  function jobBody(env: ReturnType<typeof parseEnvelope>): Record<string, unknown> {
    return (env.result ?? env.data) as Record<string, unknown>;
  }

  it('createJob persists read_back from send opts', async () => {
    const { home, jobs } = await loadModules();
    mkdirSync(join(home, '.sessionreader', 'jobs'), { recursive: true });

    const job = jobs.createJob({
      id: 'jobnew',
      sessionId: 'sess-x',
      source: 'codex',
      readBack: { source: 'codex', tokens: 8000, preset: 'full' },
      cwd: '/tmp',
      message: 'hi',
      pid: DEAD_PID,
      messageCountBefore: 3,
      isNewSession: true,
      stdoutFile: '/tmp/x.out',
      stderrFile: '/tmp/x.err',
    });
    expect(job.read_back).toEqual({ source: 'codex', tokens: 8000, preset: 'full' });

    const persisted = jobs.readJob('jobnew');
    expect(persisted?.read_back).toEqual({ source: 'codex', tokens: 8000, preset: 'full' });
    expect(existsSync(join(home, '.sessionreader', 'jobs', 'jobnew.json'))).toBe(true);
  });

  it('jobStatusCommand response includes read_back + read-back command carries --source/--tokens/--preset', async () => {
    const { home, jobCmd } = await loadModules();
    seedJob(home);

    await jobCmd.jobStatusCommand('jobreadback', { output: 'json' });

    const env = parseEnvelope();
    const body = jobBody(env);
    expect(body.read_back).toEqual({ source: 'claude', tokens: 4000, preset: 'verbose' });
    expect(body.session_id).toBe('sess-target');
    expect(body.message_count_before).toBe(7);

    const readAction = env.actions!.find((a) => /\bread\b/.test(a.command));
    expect(readAction).toBeDefined();
    expect(readAction!.command).toContain('--after 7');
    expect(readAction!.command).toContain('--source claude');
    expect(readAction!.command).toContain('--tokens 4000');
    expect(readAction!.command).toContain('--preset verbose');
  });

  it('jobWaitCommand on an already-completed job emits read_back + tooled read-back command', async () => {
    const { home, jobCmd } = await loadModules();
    seedJob(home);

    // status === 'completed' already, so wait returns immediately.
    await jobCmd.jobWaitCommand('jobreadback', { output: 'json', timeout: 1, interval: 1 });

    const env = parseEnvelope();
    const body = jobBody(env);
    expect(body.read_back).toEqual({ source: 'claude', tokens: 4000, preset: 'verbose' });

    const readAction = env.actions!.find((a) => /\bread\b/.test(a.command));
    expect(readAction).toBeDefined();
    expect(readAction!.command).toContain('--source claude');
    expect(readAction!.command).toContain('--tokens 4000');
    expect(readAction!.command).toContain('--preset verbose');
  });

  it('jobCancelCommand on a non-running job still surfaces read_back', async () => {
    const { home, jobCmd } = await loadModules();
    seedJob(home, { status: 'completed' });

    await jobCmd.jobCancelCommand('jobreadback', { output: 'json' });

    const env = parseEnvelope();
    const body = jobBody(env);
    expect(body.read_back).toEqual({ source: 'claude', tokens: 4000, preset: 'verbose' });
    const readAction = env.actions!.find((a) => /\bread\b/.test(a.command));
    expect(readAction).toBeDefined();
    expect(readAction!.command).toContain('--source claude');
    expect(readAction!.command).toContain('--tokens 4000');
    expect(readAction!.command).toContain('--preset verbose');
  });
});
