import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  findAntigravitySessions,
  parseAntigravitySession,
  getAntigravityDir,
} from '../src/parsers/antigravity.js';
import { resolveSource, getAdapter } from '../src/parsers/registry.js';

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

  it('skips corrupted JSON lines in transcript without failing', async () => {
    const tempFile = path.join(os.tmpdir(), 'corrupt-transcript.jsonl');
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
      fs.rmSync(tempFile, { force: true });
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
