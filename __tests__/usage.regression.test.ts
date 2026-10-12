import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseClaudeSession } from '../src/parsers/claude.js';
import { parseCodexSession } from '../src/parsers/codex.js';
import { deriveContextWindow, segmentTurns } from '../src/turns.js';

const timestamp = '2026-10-12T01:00:00.000Z';
async function parse(source: 'claude' | 'codex', records: object[], child = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-usage-'));
  const file = path.join(dir, child ? 'subagents/agent-child.jsonl' : 'session.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify({ timestamp, ...r })).join('\n'));
  try { return await (source === 'claude' ? parseClaudeSession : parseCodexSession)(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const user = (text = 'Synthetic prompt') => ({ type: 'user', message: { content: text } });
const assistant = (id: string, uuid: string, usage: object, text = 'Synthetic response', model = 'claude-sonnet-5-5', effort = 'high') => ({
  type: 'assistant', uuid, effort, message: { id, model, usage, content: [{ type: 'text', text }] },
});
const message = (role: string, text = 'Synthetic response') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
const count = (last: object | undefined, total?: object, extras: object = {}) => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total, model_context_window: 258400 }, ...extras } });

describe('Claude request usage regressions', () => {
  it('counts final provider usage once while preserving distinct content chunks', async () => {
    const s = await parse('claude', [user(),
      assistant('request', 'first', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 }, 'First chunk'),
      assistant('request', 'second', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 }, 'Second chunk'),
    ]);
    expect(s.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['First chunk', 'Second chunk']);
    expect(s.stats.tokenUsage).toMatchObject({ input: 100, output: 20, cacheRead: 50, cacheCreation: 25, contextTokens: 175 });
    expect(segmentTurns(s)[0].usage).toMatchObject({ input: 100, output: 20, cacheRead: 50, cacheWrite: 25, contextTokens: 175 });
  });

  it('retains cache-only and explicit-zero context snapshots', async () => {
    const cache = await parse('claude', [user(), assistant('one', 'first', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100 })]);
    expect(cache.stats.tokenUsage).toMatchObject({ input: 0, output: 0, cacheRead: 100, contextTokens: 100 });
    const zero = await parse('claude', [user(), assistant('one', 'first', { input_tokens: 100, output_tokens: 1 }), assistant('two', 'second', { input_tokens: 0, output_tokens: 1 })]);
    expect(zero.stats.tokenUsage?.contextTokens).toBe(0);
    expect(segmentTurns(zero)[0].usage?.contextTokens).toBe(0);
  });

  it('exposes latest session settings without relabeling earlier turns', async () => {
    const s = await parse('claude', [user('First prompt'), assistant('one', 'first', { input_tokens: 100, output_tokens: 1 }, 'First answer', 'claude-sonnet-5-5', 'low'),
      user('Second prompt'), assistant('two', 'second', { input_tokens: 300000, output_tokens: 1 }, 'Second answer', 'claude-opus-5-5', 'xhigh')]);
    expect(s.metadata).toMatchObject({ model: 'claude-opus-5-5', reasoningEffort: 'xhigh', contextWindow: 1000000 });
    expect(segmentTurns(s).map(t => [t.model, t.reasoningEffort, t.contextWindow])).toEqual([
      ['claude-sonnet-5-5', 'low', 200000], ['claude-opus-5-5', 'xhigh', 1000000],
    ]);
  });

  it('uses explicit and compaction evidence for 1M without inventing unknown windows', async () => {
    expect(deriveContextWindow('claude-opus-5-5[1m]')).toBe(1000000);
    expect(deriveContextWindow('claude-sonnet-5-5')).toBe(200000);
    expect(deriveContextWindow('o1-mini')).toBe(128000);
    expect(deriveContextWindow('gpt-4.1')).not.toBe(8192);
    expect(deriveContextWindow('unknown-model')).toBeUndefined();
    const s = await parse('claude', [user(), assistant('one', 'first', { input_tokens: 100, output_tokens: 1 }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 300000, postTokens: 5000 } }]);
    expect(s.metadata.contextWindow).toBe(1000000);
  });

  it('keeps sidechain usage out of parent totals while retaining explicit child usage', async () => {
    const child = { ...assistant('child', 'child-row', { input_tokens: 900, output_tokens: 90 }), isSidechain: true };
    const parent = await parse('claude', [user(), assistant('parent', 'parent-row', { input_tokens: 100, output_tokens: 5 }), child]);
    expect(parent.stats.tokenUsage).toMatchObject({ input: 100, output: 5, contextTokens: 100 });
    const explicitChild = await parse('claude', [user(), child], true);
    expect(explicitChild.stats.tokenUsage).toMatchObject({ input: 900, output: 90, contextTokens: 900 });
  });

  it('does not add embedded child tool-result usage to parent spend', async () => {
    const s = await parse('claude', [user(), assistant('parent', 'first', { input_tokens: 100, output_tokens: 5 }),
      { type: 'user', toolUseResult: { usage: { input_tokens: 999999, output_tokens: 999999 } }, message: { content: [{ type: 'tool_result', tool_use_id: 'child', content: 'Synthetic child result' }] } }]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 100, output: 5 });
  });
});

describe('Codex request usage regressions', () => {
  it('refreshes latest context, cache reads, and billable turn usage across requests', async () => {
    const s = await parse('codex', [message('user'), message('assistant'), count(usage(100, 40, 10), usage(100, 40, 10)), count(usage(200, 80, 20), usage(300, 120, 30))]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 180, output: 30, cacheRead: 120, contextTokens: 220 });
    expect(segmentTurns(s)[0].usage).toMatchObject({ input: 180, output: 30, cacheRead: 120, contextTokens: 220 });
  });

  it('does not clear usage on a rate-only snapshot', async () => {
    const s = await parse('codex', [message('user'), message('assistant'), count(usage(100, 40, 10), usage(100, 40, 10)),
      { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1791760000 } } } }]);
    expect(segmentTurns(s)[0].usage).toMatchObject({ input: 60, output: 10, cacheRead: 40, contextTokens: 110 });
    expect(s.metadata.rateLimits?.primary).toEqual({ usedPercent: 12, windowMinutes: 300, resetsAt: 1791760000 });
  });

  it('deduplicates repeated notifications but counts identical new requests', async () => {
    const last = usage(100, 40, 10);
    const s = await parse('codex', [message('user'), message('assistant'), count(last, last), count(last, last), count(last, usage(200, 80, 20))]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 120, output: 20, cacheRead: 80, contextTokens: 110 });
    expect(segmentTurns(s)[0].usage).toMatchObject({ input: 120, output: 20, cacheRead: 80 });
  });

  it('handles cumulative resets and zero context without carrying old snapshots', async () => {
    const s = await parse('codex', [message('user'), message('assistant'), count(usage(100, 40, 10), usage(100, 40, 10)), count(usage(20, 10, 2), usage(20, 10, 2)), count(usage(0, 0, 0), usage(20, 10, 2))]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 70, output: 12, cacheRead: 50, contextTokens: 0 });
  });

  it('reads actual effort and preserves turn-level metadata', async () => {
    const s = await parse('codex', [{ type: 'turn_context', payload: { model: 'first-model', effort: 'low', context_window: 100000 } }, message('user', 'First prompt'), message('assistant'),
      { type: 'turn_context', payload: { model: 'second-model', effort: 'high', context_window: 200000 } }, message('user', 'Second prompt'), message('assistant')]);
    expect(s.metadata.reasoningEffort).toBe('high');
    expect(segmentTurns(s).map(t => [t.model, t.reasoningEffort, t.contextWindow])).toEqual([
      ['first-model', 'low', 100000], ['second-model', 'high', 200000],
    ]);
  });

  it('keeps absent rate fields absent and preserves numeric reset epochs', async () => {
    const s = await parse('codex', [message('user'), count(undefined, undefined, { rate_limits: { primary: { used_percent: 12, resets_at: 1791760000 }, secondary: {} } })]);
    expect(s.metadata.rateLimits).toEqual({ primary: { usedPercent: 12, resetsAt: 1791760000 } });
  });

  it('tracks applied thread settings without relabeling completed turns', async () => {
    const s = await parse('codex', [{ type: 'turn_context', payload: { model: 'first-model', effort: 'high', context_window: 258400 } }, message('user'), message('assistant'),
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'second-model', reasoning_effort: 'medium' } } }]);
    expect(s.metadata).toMatchObject({ model: 'second-model', reasoningEffort: 'medium', contextWindow: 258400 });
    expect(segmentTurns(s)[0]).toMatchObject({ model: 'first-model', reasoningEffort: 'high' });
  });

  it('does not attach stale usage to a new prompt', async () => {
    const last = usage(100, 40, 10);
    const s = await parse('codex', [message('user', 'First prompt'), message('assistant'), count(last, last), message('user', 'Second prompt'), count(last, last), message('assistant'), count(usage(20, 10, 2), usage(120, 50, 12))]);
    expect(segmentTurns(s).map(t => t.usage?.input)).toEqual([60, 10]);
  });

  it('supports response-keyed token_usage_record and overlapping token_count once', async () => {
    const last = usage(100, 40, 10);
    const modern = { type: 'token_usage_record', payload: { thread_id: 'parent', response_id: 'response-one', usage: last, thread_token_usage: last } };
    const s = await parse('codex', [{ type: 'session_meta', payload: { id: 'parent' } }, message('user'), message('assistant'), modern, count(last, last), modern]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 60, output: 10, cacheRead: 40, contextTokens: 110 });
    expect(segmentTurns(s)[0].usage).toMatchObject({ input: 60, output: 10, cacheRead: 40 });
  });

  it('keeps explicit child-thread usage separate from parent usage', async () => {
    const s = await parse('codex', [{ type: 'session_meta', payload: { id: 'parent' } }, message('user'), message('assistant'),
      { type: 'token_usage_record', payload: { thread_id: 'child', response_id: 'child-response', usage: usage(999999, 0, 999999), thread_token_usage: usage(999999, 0, 999999) } },
      { type: 'token_usage_record', payload: { thread_id: 'parent', response_id: 'parent-response', usage: usage(100, 40, 10), thread_token_usage: usage(100, 40, 10) } }]);
    expect(s.stats.tokenUsage).toMatchObject({ input: 60, output: 10, cacheRead: 40, contextTokens: 110 });
  });
});
