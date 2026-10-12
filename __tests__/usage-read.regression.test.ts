import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSession } from '../src/discovery.js';
import { readCommand } from '../src/commands/read.js';
import { parseCodexSession } from '../src/parsers/codex.js';
import type { NormalizedSession } from '../src/types.js';

vi.mock('../src/discovery.js', () => ({ loadSession: vi.fn() }));
let session: NormalizedSession;
let dir: string;
let output: string[];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-usage-read-'));
  const file = path.join(dir, 'session.jsonl');
  const timestamp = '2026-10-12T01:00:00.000Z';
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'synthetic-session' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt '.repeat(12) }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic response '.repeat(12) }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1791760000 } } } },
  ].map(r => JSON.stringify({ timestamp, ...r })).join('\n'));
  session = await parseCodexSession(file);
  vi.mocked(loadSession).mockResolvedValue(session);
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});
async function read(opts: Parameters<typeof readCommand>[3] = {}) {
  await readCommand('synthetic-session', undefined, undefined, { output: 'json', preset: 'standard', ...opts });
  return JSON.parse(output.join(''));
}
function context(meta: Record<string, unknown>) {
  expect(meta.context_window).toBe(258400);
  expect(meta.context_tokens).toBe(110);
}

describe('read usage metadata across views', () => {
  it('exposes context on every page without requiring a summary', async () => {
    const env = await read({ page: 2, tokens: 20 });
    expect(env.ok).toBe(true);
    expect(env.result.session).toBeUndefined();
    context(env.meta);
  });
  it('exposes context for empty sessions', async () => {
    vi.mocked(loadSession).mockResolvedValue({ ...session, messages: [], stats: { ...session.stats, totalMessages: 0 } });
    const env = await read();
    expect(env.ok).toBe(true);
    context(env.meta);
  });
  it('exposes context in batch-item metadata', async () => {
    const file = path.join(dir, 'ids.txt');
    fs.writeFileSync(file, 'synthetic-session\n');
    await readCommand('', undefined, undefined, { batch: file, output: 'jsonl', preset: 'standard' });
    const envelopes = output.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(envelopes).toHaveLength(2);
    context(envelopes[1].meta);
  });
  it('projects nested rate limits to snake_case without changing numeric resets', async () => {
    const env = await read();
    expect(env.result.session.rate_limits).toEqual({ primary: { used_percent: 12, window_minutes: 300, resets_at: 1791760000 } });
  });
});
