import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseClaudeSession } from '../src/parsers/claude.js';
import { parseCodexSession } from '../src/parsers/codex.js';
import { segmentTurns } from '../src/turns.js';
import { serializeMessage } from '../src/output/serialize.js';

function withTempFile(content: string, fn: (filePath: string) => Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-compaction-test-'));
  const filePath = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(filePath, content, 'utf8');
  return fn(filePath).finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

describe('Compaction Normalization (Issue #9)', () => {
  it('normalizes Claude compact_boundary and following isCompactSummary into exactly one message', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-12T01:00:00.000Z',
        message: { role: 'user', content: 'First user prompt before compaction' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-12T01:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant reply' }] },
      }),
      // Compaction boundary
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-12T01:01:00.000Z',
        compactMetadata: {
          trigger: 'auto_limit',
          preTokens: 150000,
          postTokens: 25000,
        },
      }),
      // Following isCompactSummary record
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        timestamp: '2026-10-12T01:01:01.000Z',
        message: { role: 'user', content: 'Summary of the compacted prior conversation.' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-12T01:02:00.000Z',
        message: { role: 'user', content: 'Follow-up prompt after compaction' },
      }),
    ];

    await withTempFile(lines.join('\n'), async (filePath) => {
      const session = await parseClaudeSession(filePath);
      expect(session.stats.compactions).toBe(1);

      const compMessages = session.messages.filter((m) => m.kind === 'compaction');
      expect(compMessages).toHaveLength(1);

      const compMsg = compMessages[0];
      expect(compMsg.role).toBe('system');
      expect(compMsg.kind).toBe('compaction');
      expect(compMsg.compactionMeta).toBeDefined();
      expect(compMsg.compactionMeta!.trigger).toBe('auto_limit');
      expect(compMsg.compactionMeta!.preTokens).toBe(150000);
      expect(compMsg.compactionMeta!.postTokens).toBe(25000);
      expect(compMsg.compactionMeta!.summary).toBe('Summary of the compacted prior conversation.');

      // Compaction boundary is at index 3 (after user prompt 1 and assistant reply 2)
      expect(compMsg.index).toBe(3);

      // Verify turns are not corrupted by compaction message
      const turns = segmentTurns(session);
      expect(turns).toHaveLength(2);
      expect(turns[0].prompt.text).toBe('First user prompt before compaction');
      expect(turns[1].prompt.text).toBe('Follow-up prompt after compaction');
    });
  });

  it('normalizes Codex compacted and context_compaction events', async () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-compaction-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Do some work' }],
        },
      }),
      JSON.stringify({
        type: 'compacted',
        payload: {
          trigger: 'window_pressure',
          pre_tokens: 180000,
          post_tokens: 28000,
          summary: 'Compacted historical code reviews and test runs.',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'context_compaction',
          trigger: 'manual',
          pre_tokens: 28000,
          post_tokens: 12000,
          summary: 'Second compaction pass.',
        },
      }),
    ];

    await withTempFile(lines.join('\n'), async (filePath) => {
      const session = await parseCodexSession(filePath);
      expect(session.stats.compactions).toBe(2);

      const compMessages = session.messages.filter((m) => m.kind === 'compaction');
      expect(compMessages).toHaveLength(2);

      expect(compMessages[0].compactionMeta!.trigger).toBe('window_pressure');
      expect(compMessages[0].compactionMeta!.preTokens).toBe(180000);
      expect(compMessages[0].compactionMeta!.postTokens).toBe(28000);

      expect(compMessages[1].compactionMeta!.trigger).toBe('manual');
      expect(compMessages[1].compactionMeta!.preTokens).toBe(28000);
      expect(compMessages[1].compactionMeta!.postTokens).toBe(12000);
    });
  });

  it('serializes compaction fields and gates summary behind full preset', () => {
    const msg = {
      index: 3,
      role: 'system' as const,
      timestamp: new Date('2026-10-12T01:00:00Z'),
      content: 'Compacted context',
      blocks: [{ type: 'text' as const, text: 'Compacted context' }],
      kind: 'compaction',
      compactionMeta: {
        trigger: 'auto_limit',
        preTokens: 120000,
        postTokens: 20000,
        summary: 'Detailed summary of conversation history',
      },
    };

    // Standard preset: hides summary
    const serializedStandard = serializeMessage(msg, { preset: 'standard' });
    expect(serializedStandard['kind']).toBe('compaction');
    expect(serializedStandard['trigger']).toBe('auto_limit');
    expect(serializedStandard['pre_tokens']).toBe(120000);
    expect(serializedStandard['post_tokens']).toBe(20000);
    expect(serializedStandard['summary']).toBeUndefined();

    // Verbose preset: summary still hidden
    const serializedVerbose = serializeMessage(msg, { preset: 'verbose' });
    expect(serializedVerbose['summary']).toBeUndefined();

    // Full preset: surfaces summary
    const serializedFull = serializeMessage(msg, { preset: 'full' });
    expect(serializedFull['summary']).toBe('Detailed summary of conversation history');
  });
});
