import { describe, it, expect, afterEach } from 'vitest';
import { createJob, deleteJob, updateJob } from '../src/jobs.js';
import { jobStatusCommand } from '../src/commands/job.js';
import type { Job } from '../src/types.js';

const createdJobIds: string[] = [];

afterEach(() => {
  for (const id of createdJobIds.splice(0)) {
    deleteJob(id);
  }
});

describe('jobs', () => {
  it('persists read_back settings and replays them in read actions', async () => {
    const job = createJob({
      id: `test-${Date.now()}`,
      sessionId: 'session-123',
      source: 'claude',
      readBack: {
        source: 'claude',
        tokens: 4000,
        preset: 'verbose',
      },
      cwd: process.cwd(),
      message: 'hi',
      pid: process.pid,
      messageCountBefore: 7,
      isNewSession: false,
      stdoutFile: '/tmp/sessionr-test.stdout',
      stderrFile: '/tmp/sessionr-test.stderr',
    });
    createdJobIds.push(job.id);

    const completed: Job = {
      ...job,
      status: 'completed',
      exit_code: 0,
      completed_at: new Date().toISOString(),
    };
    updateJob(completed);

    let output = '';
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      output += String(value);
    };
    try {
      await jobStatusCommand(job.id, { output: 'json' });
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(output) as {
      data: { read_back: { source: string; tokens: number; preset: string } };
      actions: Array<{ command: string }>;
    };
    expect(parsed.data.read_back).toEqual({
      source: 'claude',
      tokens: 4000,
      preset: 'verbose',
    });
    expect(parsed.actions[0]?.command).toBe(
      'sessionr read session-123 --after 7 --source claude --tokens 4000 --preset verbose',
    );
  });
});
