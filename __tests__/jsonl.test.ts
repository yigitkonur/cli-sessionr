import { describe, it, expect } from 'vitest';
import { createJsonlFormatter } from '../src/output/jsonl.js';
import { SessionReaderError } from '../src/errors.js';
import type {
  NormalizedSession,
  NormalizedMessage,
  SessionListEntry,
  VerbosityPreset,
  SliceMeta,
} from '../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeSession(overrides?: Partial<NormalizedSession>): NormalizedSession {
  const updated = new Date('2026-05-26T12:34:56.000Z');
  return {
    id: 'sess_abc12345',
    source: 'claude',
    filePath: '/tmp/sess.jsonl',
    metadata: {
      cwd: '/repo',
      gitBranch: 'main',
      gitRepo: 'github.com/x/y',
      model: 'claude-opus',
      createdAt: updated,
      updatedAt: updated,
      fileBytes: 1024,
      rawLineCount: 10,
    },
    messages: [],
    stats: {
      totalMessages: 0,
      byRole: { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
      byBlockType: {},
      toolFrequency: [],
      filesModified: [],
    },
    ...overrides,
  };
}

function makeEntry(over?: Partial<SessionListEntry>): SessionListEntry {
  return {
    id: 'sess_aaa',
    source: 'claude',
    cwd: '/repo',
    updatedAt: new Date('2026-05-26T00:00:00.000Z'),
    filePath: '/tmp/a.jsonl',
    isEmpty: false,
    ...over,
  };
}

function makeMessage(index: number, role: NormalizedMessage['role']): NormalizedMessage {
  return {
    index,
    role,
    timestamp: new Date('2026-05-26T01:00:00.000Z'),
    content: `msg ${index}`,
    blocks: [{ type: 'text', text: `msg ${index}` }],
  };
}

const PRESET: VerbosityPreset = {
  name: 'standard',
  maxContentChars: 500,
  maxToolInputChars: 60,
  maxToolResultChars: 80,
  showThinking: false,
  maxThinkingChars: 0,
  showToolArgs: true,
  showToolResults: true,
};

/**
 * Every formatter.list() / formatter.read() output must split on `\n` into
 * JSONL-valid records. Trailing newline OK; empty trailing line is filtered.
 */
function assertJsonl(output: string): unknown[] {
  const lines = output.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(
        `line ${i} is not valid JSON: ${JSON.stringify(line)} (err: ${(err as Error).message})`,
      );
    }
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('jsonl formatter — list()', () => {
  it('emits one valid JSON object per line', () => {
    const fmt = createJsonlFormatter();
    const entries: SessionListEntry[] = [
      makeEntry({ id: 'sess_a' }),
      makeEntry({ id: 'sess_b' }),
      makeEntry({ id: 'sess_c' }),
    ];
    const out = fmt.list(entries);
    const parsed = assertJsonl(out);
    expect(parsed).toHaveLength(3);
    for (const obj of parsed) {
      expect(obj).toMatchObject({ type: 'session' });
    }
  });

  it('serializes Date fields as ISO 8601 strings (no JSON.stringify default)', () => {
    const fmt = createJsonlFormatter();
    const out = fmt.list([
      makeEntry({ updatedAt: new Date('2026-01-02T03:04:05.000Z') }),
    ]);
    const [first] = assertJsonl(out);
    expect((first as { updatedAt: string }).updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('empty list returns empty string (caller must decide envelope behaviour)', () => {
    const fmt = createJsonlFormatter();
    expect(fmt.list([])).toBe('');
  });
});

describe('jsonl formatter — read()', () => {
  it('emits a meta line followed by one JSON line per message', () => {
    const fmt = createJsonlFormatter();
    const session = makeSession();
    const messages = [makeMessage(1, 'user'), makeMessage(2, 'assistant')];
    const out = fmt.read(session, messages, 1, 2, PRESET);
    const parsed = assertJsonl(out);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      type: 'meta',
      session_id: 'sess_abc12345',
      source: 'claude',
      range: { from: 1, to: 2 },
    });
    expect(parsed[1]).toMatchObject({ type: 'message', index: 1, role: 'user' });
    expect(parsed[2]).toMatchObject({ type: 'message', index: 2, role: 'assistant' });
  });

  it('uses supplied SliceMeta verbatim when provided', () => {
    const fmt = createJsonlFormatter();
    const session = makeSession();
    const meta: SliceMeta = {
      session_id: 'sess_abc12345',
      source: 'claude',
      total_messages: 50,
      total_tokens_estimate: 1000,
      returned_tokens_estimate: 200,
      token_budget: 4000,
      anchor: 'head',
      range: { from: 1, to: 5 },
      has_more_before: false,
      has_more_after: true,
      cursor_before: null,
      cursor_after: 5,
      cursor: { next: null, prev: null, first: null },
    };
    const out = fmt.read(session, [], 1, 5, PRESET, meta);
    const parsed = assertJsonl(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      type: 'meta',
      session_id: 'sess_abc12345',
      anchor: 'head',
    });
  });

  it('every emitted line round-trips through JSON.parse', () => {
    const fmt = createJsonlFormatter();
    const session = makeSession();
    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1, 'user'));
    const out = fmt.read(session, messages, 1, 5, PRESET);
    // assertJsonl already throws on any bad line; existence assertion below.
    expect(assertJsonl(out)).toHaveLength(6);
  });
});

describe('jsonl formatter — stats()', () => {
  it('emits a single line tagged with type:stats', () => {
    const fmt = createJsonlFormatter();
    const out = fmt.stats(makeSession());
    const parsed = assertJsonl(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: 'stats', id: 'sess_abc12345' });
  });

  it('strips messages array from stats output (cheap stats, not full transcript)', () => {
    const fmt = createJsonlFormatter();
    const session = makeSession({
      messages: [makeMessage(1, 'user')],
    });
    const out = fmt.stats(session);
    const [obj] = assertJsonl(out) as Array<Record<string, unknown>>;
    expect(obj.messages).toBeUndefined();
  });
});

describe('jsonl formatter — error()', () => {
  it('produces a single JSONL line for a SessionReaderError', () => {
    const fmt = createJsonlFormatter();
    const err = new SessionReaderError('boom', {
      code: 'BOOM',
      detail: { reason: 'test' },
    });
    const out = fmt.error(err);
    const parsed = assertJsonl(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      type: 'error',
      error: { code: 'BOOM', message: 'boom' },
    });
  });

  it('falls back to UNKNOWN_ERROR for plain Error instances', () => {
    const fmt = createJsonlFormatter();
    const out = fmt.error(new Error('plain'));
    const [parsed] = assertJsonl(out) as Array<Record<string, unknown>>;
    const errorField = (parsed as { error: { code: string } }).error;
    expect(errorField.code).toBe('UNKNOWN_ERROR');
  });
});
