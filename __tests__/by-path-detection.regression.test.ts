import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSessionByPath } from '../src/index.js';

const dirs: string[] = [];
const claudeRecord = (content = 'synthetic prompt') => JSON.stringify({
  type: 'user', uuid: 'message-1', sessionId: 'synthetic-session',
  timestamp: '2026-10-12T00:00:00.000Z', message: { role: 'user', content },
});
function fixture(relative: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-format-'));
  dirs.push(dir);
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('Direct-path source detection', () => {
  it('does not infer formats from project names', async () => {
    const file = fixture('codex-project/session.jsonl', claudeRecord());
    const session = await loadSessionByPath(file);
    expect(session.source).toBe('claude');
    expect(session.messages).toHaveLength(1);
  });

  it('checks record shape rather than keywords in conversation text', async () => {
    const file = fixture('session.jsonl', claudeRecord('exec_command apply_patch response_item'));
    const session = await loadSessionByPath(file);
    expect(session.source).toBe('claude');
    expect(session.messages).toHaveLength(1);
  });

  it('matches canonical roots before a project name', async () => {
    const file = fixture('.claude/projects/codex-project/session.jsonl', claudeRecord());
    expect((await loadSessionByPath(file)).source).toBe('claude');
  });

  it('never treats an agy canonical path as a Gemini JSON session', async () => {
    const file = fixture('.gemini/antigravity-cli/brain/synthetic/.system_generated/logs/transcript_full.jsonl',
      JSON.stringify({ type: 'USER_INPUT', step_index: 0, created_at: '2026-10-12T00:00:00Z', content: 'synthetic' }));
    // #17 added the Antigravity adapter, so the canonical agy root now resolves to it (and never to Gemini).
    const session = await loadSessionByPath(file);
    expect(session.source).toBe('antigravity');
    expect(session.source).not.toBe('gemini');
  });

  it('reports ambiguous record formats instead of returning zero messages', async () => {
    const file = fixture('session.jsonl', claudeRecord() + '\n' + JSON.stringify({
      type: 'session_meta', payload: { id: 'synthetic-codex' },
    }));
    await expect(loadSessionByPath(file)).rejects.toMatchObject({ code: 'AMBIGUOUS_SESSION_FORMAT' });
  });

  it('reports unknown formats and permits an explicit source override', async () => {
    const file = fixture('session.jsonl', JSON.stringify({ unrelated: true }));
    await expect(loadSessionByPath(file)).rejects.toMatchObject({ code: 'UNRECOGNIZED_SESSION_FILE' });
    expect((await loadSessionByPath(file, 'claude')).source).toBe('claude');
  });
});
