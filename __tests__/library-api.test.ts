import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  read,
  getStats,
  loadSessionByPath,
  registerSource,
  type SourceAdapter,
  type NormalizedSession,
} from '../src/index.js';

const CODEX_FIXTURE = path.resolve(__dirname, 'fixtures/codex-session.jsonl');
const CLAUDE_FIXTURE = path.resolve(__dirname, 'fixtures/claude-session.jsonl');

describe('Library API: Programmatic read(), loadSessionByPath, and registerSource (Issue #5)', () => {
  it('reads the small Codex fixture by path within a 500ms smoke-test bound', async () => {
    const t0 = performance.now();
    const env = await read(CODEX_FIXTURE);
    const durationMs = performance.now() - t0;

    console.info(`Codex fixture direct read: ${durationMs.toFixed(2)}ms (${fs.statSync(CODEX_FIXTURE).size} bytes)`);
    expect(durationMs).toBeLessThan(500); // Small-fixture smoke, not the 10 MB acceptance benchmark.
    expect(env.ok).toBe(true);
    expect(env.source).toBe('codex');
    expect(env.messages.length).toBeGreaterThan(0);
    expect(env.meta).toBeDefined();
    expect(env.meta.range).toBeDefined();
    expect(env.meta.total_messages).toBeGreaterThan(0);
  });

  it('reads session by { path, source } reference object', async () => {
    const env = await read({ path: CODEX_FIXTURE, source: 'codex' });
    expect(env.ok).toBe(true);
    expect(env.source).toBe('codex');
    expect(env.messages.length).toBeGreaterThan(0);
  });

  it('loads session directly by path using loadSessionByPath', async () => {
    const session = await loadSessionByPath(CLAUDE_FIXTURE, 'claude');
    expect(session.id).toBeDefined();
    expect(session.source).toBe('claude');
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.stats).toBeDefined();
  });

  it('allows registering a custom source adapter via registerSource without forking', async () => {
    const customAdapter: SourceAdapter = {
      name: 'custom-tool' as any,
      label: 'Custom Tool',
      color: '#ff00ff',
      getDataDir: () => '/tmp/custom-tool',
      find: async () => [],
      parse: async (filePath: string): Promise<NormalizedSession> => ({
        id: 'custom-session-123',
        source: 'custom-tool' as any,
        filePath,
        metadata: {
          cwd: '/tmp',
          createdAt: new Date(),
          updatedAt: new Date(),
          fileBytes: 100,
          rawLineCount: 1,
        },
        messages: [
          {
            index: 1,
            role: 'user',
            timestamp: new Date(),
            content: 'Hello custom tool',
            blocks: [{ type: 'text', text: 'Hello custom tool' }],
          },
        ],
        stats: {
          totalMessages: 1,
          byRole: { user: 1, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
          byBlockType: { text: 1 },
          toolFrequency: [],
          filesModified: [],
        },
      }),
    };

    registerSource(customAdapter);

    const dummyPath = '/tmp/sessionr-custom-test.jsonl';
    fs.writeFileSync(dummyPath, '{"dummy": true}\n');
    try {
      const env = await read({ path: dummyPath, source: 'custom-tool' });
      expect(env.ok).toBe(true);
      expect(env.sessionId).toBe('custom-session-123');
      expect(env.source).toBe('custom-tool');
      expect(env.messages).toHaveLength(1);
      expect(env.messages[0].content).toBe('Hello custom tool');
    } finally {
      if (fs.existsSync(dummyPath)) fs.unlinkSync(dummyPath);
    }
  });

  it('retrieves stats directly using getStats()', async () => {
    const stats = await getStats(CODEX_FIXTURE);
    expect(stats).toBeDefined();
    expect(stats.totalMessages).toBeGreaterThan(0);
    expect(stats.byRole).toBeDefined();
  });
});
