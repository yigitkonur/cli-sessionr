import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  findAntigravitySessions,
  parseAntigravitySession,
  getAntigravityDir,
} from '../src/parsers/antigravity.js';
import { resolveSource, getAdapter } from '../src/parsers/registry.js';
import { getResumeHint } from '../src/resume.js';
import { buildResumeCommand } from '../src/runners.js';
import { listCommand } from '../src/commands/list.js';
import { listSessionsScoped } from '../src/discovery.js';

vi.mock('../src/discovery.js', () => ({
  listSessionsScoped: vi.fn(),
  loadSession: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'antigravity-session');

describe('Antigravity CLI Discovery & Environment Resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env['ANTIGRAVITY_APP_DATA_DIR'];
    delete process.env['ANTIGRAVITY_DATA_DIR'];
    delete process.env['ANTIGRAVITY_HOME'];
    delete process.env['GEMINI_CLI_HOME'];
  });

  afterEach(() => {
    delete process.env['ANTIGRAVITY_APP_DATA_DIR'];
    delete process.env['ANTIGRAVITY_DATA_DIR'];
    delete process.env['ANTIGRAVITY_HOME'];
    delete process.env['GEMINI_CLI_HOME'];
    vi.unstubAllEnvs();
  });

  it('respects ANTIGRAVITY_HOME environment variable override', async () => {
    process.env['ANTIGRAVITY_HOME'] = FIXTURES_DIR;
    expect(getAntigravityDir()).toBe(FIXTURES_DIR);

    const sessions = await findAntigravitySessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates history entries for the same conversationId', async () => {
    process.env['ANTIGRAVITY_HOME'] = FIXTURES_DIR;
    const sessions = await findAntigravitySessions();

    const testSessions = sessions.filter((s) => s.id === 'ag-test-uuid-1234');
    expect(testSessions.length).toBe(1);
    expect(testSessions[0].summary).toBe('Can you summarize the changes made?');
    expect(testSessions[0].cwd).toBe('/home/user/project');
  });

  it('discovers orphaned brain sessions absent from history.jsonl', async () => {
    process.env['ANTIGRAVITY_HOME'] = FIXTURES_DIR;
    const sessions = await findAntigravitySessions();

    const orphan = sessions.find((s) => s.id === 'ag-orphan-uuid-5678');
    expect(orphan).toBeDefined();
    expect(orphan!.source).toBe('antigravity');
    expect(orphan!.summary).toContain('Headless orphan task');
  });

  it('gracefully skips history entries whose brain directories are purged', async () => {
    process.env['ANTIGRAVITY_HOME'] = FIXTURES_DIR;
    const sessions = await findAntigravitySessions();

    // ag-pruned-uuid-9999 has no brain directory in fixtures
    const pruned = sessions.find((s) => s.id === 'ag-pruned-uuid-9999');
    expect(pruned).toBeUndefined();
  });

  it('falls back to brain directory scanning when history.jsonl is missing', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-no-hist-'));
    try {
      const brainDir = path.join(tempHome, 'brain', 'sess-1', '.system_generated', 'logs');
      fs.mkdirSync(brainDir, { recursive: true });
      fs.writeFileSync(
        path.join(brainDir, 'transcript.jsonl'),
        '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-10T12:00:00Z","content":"Hello world"}\n',
      );

      process.env['ANTIGRAVITY_HOME'] = tempHome;
      const sessions = await findAntigravitySessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe('sess-1');
      expect(sessions[0].summary).toBe('Hello world');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('returns empty array when brain directory is missing or empty', async () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-empty-'));
    try {
      process.env['ANTIGRAVITY_HOME'] = emptyHome;
      const sessions = await findAntigravitySessions();
      expect(sessions).toEqual([]);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('parses session directory input directly as alternative to transcript.jsonl', async () => {
    const sessionDir = path.join(FIXTURES_DIR, 'brain', 'ag-test-uuid-1234');
    const session = await parseAntigravitySession(sessionDir);
    expect(session.source).toBe('antigravity');
    expect(session.messages.length).toBe(22);
  });

  it('skips corrupted JSON lines without touching a pre-existing temp-root file', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-temp-root-'));
    const sentinel = path.join(tempRoot, 'corrupt-transcript.jsonl');
    fs.writeFileSync(sentinel, 'leave this file alone');
    const tmpdir = vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
    try {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-corrupt-'));
      const tempFile = path.join(tempDir, 'corrupt-transcript.jsonl');
      try {
        fs.writeFileSync(
          tempFile,
          '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-10T12:00:00Z","content":"Valid prompt"}\n' +
          'INVALID_JSON_CORRUPT_BYTES\n' +
          '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-10T12:00:01Z","content":"Valid response"}\n',
        );
        const session = await parseAntigravitySession(tempFile);
        expect(session.messages.length).toBe(2);
        expect(session.messages[0].content).toBe('Valid prompt');
        expect(session.messages[1].content).toBe('Valid response');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('leave this file alone');
    } finally {
      tmpdir.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('Antigravity Registry & Aliases', () => {
  it('resolves antigravity canonical and alias names', () => {
    expect(resolveSource('antigravity')).toBe('antigravity');
    expect(resolveSource('agy')).toBe('antigravity');
    expect(resolveSource('antigravity-cli')).toBe('antigravity');
  });

  it('registers Antigravity adapter with label and color', () => {
    const adapter = getAdapter('antigravity');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('antigravity');
    expect(adapter!.label).toBe('Antigravity');
  });
});

describe('Antigravity transcript regressions', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-regression-'));
    vi.stubEnv('ANTIGRAVITY_APP_DATA_DIR', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function writeTranscript(id: string, records: unknown[], full = false): string {
    const logs = path.join(tempHome, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, full ? 'transcript_full.jsonl' : 'transcript.jsonl');
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    return file;
  }

  it('prefers full transcripts for discovery and directories, with canonical fallback and explicit-file fidelity', async () => {
    const records = (label: string) => [
      { type: 'USER_INPUT', content: `${label} prompt` },
      { type: 'PLANNER_RESPONSE', content: `${label} answer`, tool_calls: [{ name: 'run_command' }] },
      { type: 'GENERIC', content: `${label} result` },
    ];
    const canonical = writeTranscript('dual', records('canonical'));
    const full = writeTranscript('dual', records('full'), true);
    const dir = path.join(tempHome, 'brain', 'dual');
    const entries = await findAntigravitySessions();
    expect(entries[0].filePath).toBe(full);
    expect((await parseAntigravitySession(dir)).messages.map((m) => m.content)).toEqual([
      'full prompt', 'full answer', 'Tool: run_command', 'full result',
    ]);
    expect((await parseAntigravitySession(canonical)).messages.map((m) => m.content)).toEqual([
      'canonical prompt', 'canonical answer', 'Tool: run_command', 'canonical result',
    ]);
    fs.rmSync(full);
    expect((await findAntigravitySessions())[0].filePath).toBe(canonical);
    expect((await parseAntigravitySession(dir)).messages[0].content).toBe('canonical prompt');
  });

  it('preserves typed full-transcript arguments without coercing numeric-looking strings', async () => {
    const call = (args: Record<string, unknown>) => [{
      type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args }],
    }];
    writeTranscript('typed', call({ WaitMsBeforeAsync: '2000', RunPersistent: 'false' }));
    writeTranscript('typed', call({ WaitMsBeforeAsync: 2000, RunPersistent: false, CommandLine: '123' }), true);
    const session = await parseAntigravitySession(path.join(tempHome, 'brain', 'typed'));
    const block = session.messages[0].blocks[0];
    expect(block.type).toBe('tool_use');
    if (block.type !== 'tool_use') throw new Error('Expected tool call');
    expect(block.input.WaitMsBeforeAsync).toBe(2000);
    expect(block.input.RunPersistent).toBe(false);
    expect(block.input.CommandLine).toBe('123');
  });

  it.each([
    ['finished', 0, false],
    ['failed', 0, true],
    ['cancelled', 0, true],
    ['canceled', 0, true],
    ['finished', 2, true],
    ['finished', -1, true],
  ])('links background completion %s (exit %i) to its original call and keeps system text', async (outcome, exit, isError) => {
    const taskId = '8870b007-42b0-4ffa-a47b-9acb5821ef3f/task-1';
    const completion = `<SYSTEM_MESSAGE sender=${taskId} content=Task ${outcome} with result: The command exited with code ${exit}</SYSTEM_MESSAGE>`;
    const file = writeTranscript('background', [
      { type: 'USER_INPUT', content: 'Run in background' },
      { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'run_command' }] },
      { type: 'GENERIC', status: 'RUNNING', content: `Task ID: "${taskId}"` },
      { type: 'PLANNER_RESPONSE', step_index: 3, tool_calls: [{ name: 'read_file' }] },
      { type: 'GENERIC', status: 'DONE', content: 'unrelated result' },
      { type: 'SYSTEM_MESSAGE', content: completion },
      { type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE sender=${taskId.replace('task-1', 'task-9')} content=Task finished with result: unmatched</SYSTEM_MESSAGE>` },
    ]);
    const session = await parseAntigravitySession(file);
    const results = session.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(3);
    expect(results[2].toolUseId).toBe(results[0].toolUseId);
    expect(results[2].toolUseId).not.toBe(results[1].toolUseId);
    expect(results[2].isError).toBe(isError);
    expect(session.stats.toolFrequency.find((t) => t.name === 'run_command')?.errors).toBe(isError ? 1 : 0);
    expect(session.messages.some((m) => m.role === 'system' && m.content === completion)).toBe(true);
  });




  it('uses the first non-completion system mission as a prompt only when no real user input exists', async () => {
    const mission = '<SYSTEM_MESSAGE sender=lead content=Implement the mission\nKeep the scope narrow.</SYSTEM_MESSAGE>';
    const file = writeTranscript('mission', [
      { type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE sender=8870b007-42b0-4ffa-a47b-9acb5821ef3f/task-9 content=Task finished with result: ok</SYSTEM_MESSAGE>' },
      { type: 'SYSTEM_MESSAGE', content: mission },
      { type: 'PLANNER_RESPONSE', content: 'Mission accepted' },
      { type: 'SYSTEM_MESSAGE', content: 'Later system notification' },
    ]);
    const session = await parseAntigravitySession(file);
    expect(session.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'Implement the mission\nKeep the scope narrow.',
    ]);
    expect(session.messages[0].role).toBe('system');
    expect(session.messages.at(-1)?.role).toBe('system');
    for (const type of ['USER_INPUT', 'USER_MESSAGE']) {
      const realUserFile = writeTranscript('real-user', [
        { type: 'SYSTEM_MESSAGE', content: mission },
        { type, content: '<USER_REQUEST>Real user request</USER_REQUEST>' },
      ]);
      const realUserSession = await parseAntigravitySession(realUserFile);
      expect(realUserSession.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Real user request']);
      expect(realUserSession.messages[0].role).toBe('system');
    }
  });


  it('marks checkpoint-only sessions empty but keeps system missions and later conversation evidence in list', async () => {
    writeTranscript('checkpoint', [{ type: 'CHECKPOINT', content: 'metadata only' }]);
    writeTranscript('system-mission', [{ type: 'SYSTEM_MESSAGE', content: 'Agent mission brief' }]);
    writeTranscript('later-prompt', [
      ...Array.from({ length: 35 }, () => ({ type: 'CHECKPOINT', content: 'metadata only' })),
      { type: 'USER_MESSAGE', content: 'Later valid prompt' },
    ]);
    fs.writeFileSync(path.join(tempHome, 'history.jsonl'), JSON.stringify({
      conversationId: 'checkpoint', workspace: '/synthetic/project', display: 'Stale metadata',
    }) + '\n');
    const entries = await findAntigravitySessions();
    expect(entries.find((e) => e.id === 'checkpoint')?.isEmpty).toBe(true);
    expect(entries.find((e) => e.id === 'system-mission')?.isEmpty).toBe(false);
    expect(entries.find((e) => e.id === 'later-prompt')?.isEmpty).toBe(false);
    vi.mocked(listSessionsScoped).mockResolvedValue({
      sessions: entries, meta: { cwd_scope: 'all', cwd: tempHome },
    });
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const previousExitCode = process.exitCode;
    try {
      await listCommand('antigravity', { output: 'json', cwd: 'all' });
      const envelope = JSON.parse(chunks.join(''));
      expect(envelope.ok).toBe(true);
      expect(envelope.result.sessions.map((e: { id: string }) => e.id).sort()).toEqual(['later-prompt', 'system-mission']);
    } finally {
      stdout.mockRestore();
      vi.mocked(listSessionsScoped).mockReset();
      process.exitCode = previousExitCode;
    }
  });


  it('prefers a real user summary over a system preamble even after cwd is found', async () => {
    writeTranscript('preamble', [
      { type: 'SYSTEM_MESSAGE', content: 'System preamble' },
      { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { Cwd: '/synthetic/project' } }] },
      { type: 'USER_INPUT', content: '<USER_REQUEST>Actual user request</USER_REQUEST>' },
    ]);
    writeTranscript('no-user', [
      { type: 'SYSTEM_MESSAGE', content: 'Agent mission brief' },
      { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { Cwd: '/synthetic/project' } }] },
    ]);
    const entries = await findAntigravitySessions();
    expect(entries.find((e) => e.id === 'preamble')?.summary).toBe('Actual user request');
    expect(entries.find((e) => e.id === 'preamble')?.cwd).toBe('/synthetic/project');
    expect(entries.find((e) => e.id === 'no-user')?.summary).toBe('Agent mission brief');
  });

});


describe('Antigravity resume hints', () => {
  it.each([
    ['two words', "'two words'"],
    ['id; printf injected; #', "'id; printf injected; #'"],
    ['$(printf injected)', "'$(printf injected)'"],
    ["it's a session", "'it'\\''s a session'"],
  ])('quotes session id %s as a literal and mirrors the unverified runner form', (id, literal) => {
    const hint = getResumeHint('antigravity', id);
    expect(hint.resume).toContain(`send ${literal} -f prompt.md --source antigravity`);
    expect(hint.resume_async).toBe(`${hint.resume} --async`);
    const runner = buildResumeCommand('antigravity', id, 'prompt text');
    expect(runner.args).toEqual(['--resume', id, 'prompt text']);
    expect(hint.direct).toBe(`${runner.bin} --resume ${literal} "$(cat prompt.md)"`);
    expect(hint.verified).toBe(false);
    expect(getResumeHint('codex', id).resume).toContain(`send ${literal} -f prompt.md`);
  });
});
