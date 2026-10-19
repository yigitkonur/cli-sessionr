import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseClaudeSession } from '../src/parsers/claude.js';
import { parseCodexSession } from '../src/parsers/codex.js';
import { serializeMessage } from '../src/output/serialize.js';
import type { NormalizedMessage } from '../src/types.js';

const timestamp = '2026-10-12T01:00:00.000Z';
const summary = 'SYNTHETIC_SUMMARY_SENTINEL';
async function parse(source: 'claude' | 'codex', records: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-compaction-regression-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify({ timestamp, ...r })).join('\n'));
  try { return await (source === 'claude' ? parseClaudeSession : parseCodexSession)(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const user = { type: 'user', message: { content: 'Synthetic prompt' } };
const boundary = { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 300000, postTokens: 5000 } };
const compactSummary = (role = 'user', array = false) => ({ type: role, isCompactSummary: true, message: { content: array ? [{ type: 'text', text: summary }] : summary } });
const item = (id = 'item-13') => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id } } });

function hidden(message: NormalizedMessage) {
  for (const preset of ['minimal', 'standard', 'verbose'] as const) {
    const projected = serializeMessage(message, { preset });
    expect(JSON.stringify(projected)).not.toContain(summary);
    expect(projected.compaction_meta).not.toHaveProperty('preTokens');
    expect(projected.compaction_meta).not.toHaveProperty('postTokens');
  }
  expect(JSON.stringify(serializeMessage(message, { preset: 'full', detail: 'meta' }))).not.toContain(summary);
  expect(serializeMessage(message, { preset: 'full' }).summary).toBe(summary);
}

describe('Claude compaction regressions', () => {
  it('pairs an automatic boundary with a summary across bookkeeping records', async () => {
    const s = await parse('claude', [user, boundary,
      { type: 'attachment', attachment: { type: 'compact_file_reference' } },
      { type: 'file-history-snapshot' }, { type: 'queue-operation' }, compactSummary('assistant', true)]);
    expect(s.stats.compactions).toBe(1);
    const markers = s.messages.filter(m => m.kind === 'compaction');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ index: 2, rawLineIndex: 1, role: 'system', compactionMeta: { trigger: 'auto', preTokens: 300000, postTokens: 5000, summary } });
    hidden(markers[0]);
  });

  it('extracts standalone assistant array summaries', async () => {
    const s = await parse('claude', [user, compactSummary('assistant', true)]);
    expect(s.stats.compactions).toBe(1);
    expect(s.messages[1].compactionMeta?.summary).toBe(summary);
    hidden(s.messages[1]);
  });

  it('does not pair a summary across real conversation or another boundary', async () => {
    const s = await parse('claude', [user, boundary, user, compactSummary(), boundary, boundary, compactSummary()]);
    expect(s.stats.compactions).toBe(4);
    const markers = s.messages.filter(m => m.kind === 'compaction');
    expect(markers.map(m => m.compactionMeta?.summary)).toEqual([undefined, summary, undefined, summary]);
  });
});

describe('Codex compaction regressions', () => {
  it('preserves actual payload.message summaries without inventing a trigger', async () => {
    const s = await parse('codex', [{ type: 'compacted', payload: { message: summary, replacement_history: [] } }]);
    expect(s.stats.compactions).toBe(1);
    expect(s.messages[0].compactionMeta).toEqual({ summary });
    hidden(s.messages[0]);
  });

  it('extracts readable replacement-history summaries but not encrypted content', async () => {
    const readable = await parse('codex', [{ type: 'compacted', payload: { message: '', replacement_history: [{ type: 'compaction', content: [{ type: 'output_text', text: summary }] }] } }]);
    expect(readable.messages[0].compactionMeta?.summary).toBe(summary);
    const opaque = await parse('codex', [{ type: 'compacted', payload: { message: '', replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-private-bytes' }] } }]);
    expect(opaque.messages[0].compactionMeta?.summary).toBeUndefined();
    expect(JSON.stringify(serializeMessage(opaque.messages[0], { preset: 'full' }))).not.toContain('opaque-private-bytes');
  });

  it('supports completed ContextCompaction items without a top-level copy', async () => {
    const s = await parse('codex', [item()]);
    expect(s.stats.compactions).toBe(1);
    expect(s.messages[0]).toMatchObject({ index: 1, rawLineIndex: 0, role: 'system', kind: 'compaction' });
  });

  it('counts paired top-level and completed-item representations once', async () => {
    const s = await parse('codex', [{ type: 'compacted', payload: { message: summary } },
      { type: 'world_state' }, { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
      { type: 'event_msg', payload: { type: 'token_count', info: null } },
      { ...item(), timestamp: '2026-10-12T01:00:00.013Z' }]);
    expect(s.stats.compactions).toBe(1);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ rawLineIndex: 0, compactionMeta: { summary } });
  });

  it('supports wrapped compaction events and preserves known numeric metadata', async () => {
    const s = await parse('codex', [{ type: 'event_msg', payload: { type: 'compacted', trigger: 'manual', pre_tokens: 100, post_tokens: 0, summary } }]);
    expect(s.stats.compactions).toBe(1);
    expect(s.messages[0].compactionMeta).toEqual({ trigger: 'manual', preTokens: 100, postTokens: 0, summary });
    expect(serializeMessage(s.messages[0], { preset: 'full' }).compaction_meta).toEqual({ trigger: 'manual', pre_tokens: 100, post_tokens: 0, summary });
  });

  it('does not collapse independent compactions or reused item ids after activity', async () => {
    const s = await parse('codex', [item(), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic work' }] } }, item(),
      { type: 'compacted', timestamp: '2026-10-12T01:10:00.000Z', payload: {} }]);
    expect(s.stats.compactions).toBe(3);
  });
});

describe('full-only compaction summary projection', () => {
  it('does not leak legacy summaries through content, blocks or nested metadata', () => {
    hidden({ index: 1, role: 'system', timestamp: new Date(timestamp), kind: 'compaction', content: summary,
      blocks: [{ type: 'text', text: summary }], compactionMeta: { trigger: 'manual', preTokens: 100, postTokens: 10, summary } });
  });
});
