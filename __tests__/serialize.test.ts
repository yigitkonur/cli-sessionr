/**
 * Unit tests for src/output/serialize.ts.
 *
 * Drives the four cross-cutting contracts of `serializeMessage`:
 *
 *   1. Pure text-only messages always dedup to `content` (no `blocks`).
 *   2. Rich messages route ONE channel based on preset:
 *        minimal/standard → `content` only (blocks stripped)
 *        verbose/full     → `blocks` only  (content stripped)
 *        default          → `blocks` only  (no dual-channel waste)
 *   3. `detail=meta` strips everything except role identity, but preserves
 *      `tool_use_id` + `"Tool: <name>"` so agents can join tool_use ↔
 *      tool_result and re-fetch later.
 *   4. `toExternal` walks objects, renames camelCase → snake_case (per the
 *      curated map), and converts Date instances to ISO strings.
 *
 * Why direct unit coverage (not just integration)? Because every command
 * call-site eventually routes through this one helper — a regression in
 * serializeMessage's policy table silently breaks every JSON envelope
 * across the CLI. Unit-testing the policy keeps the contract observable
 * without bringing up `dist/cli.js`.
 */
import { describe, it, expect } from 'vitest';
import { serializeMessage, toExternal, toExternalSession } from '../src/output/serialize.js';
import type { NormalizedMessage, NormalizedSession, ContentBlock } from '../src/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function toolUseBlock(name: string, id = 'call_abc', input: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

function toolResultBlock(toolUseId: string, content: string, isError = false): ContentBlock {
  return { type: 'tool_result', toolUseId, content, isError };
}

function makeMessage(over: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    index: 1,
    role: 'user',
    timestamp: new Date('2026-05-27T00:00:00.000Z'),
    content: 'hello',
    blocks: [textBlock('hello')],
    ...over,
  };
}

// ── 1. Text-only messages: always dedup ───────────────────────────────────

describe('serializeMessage — text-only dedup', () => {
  it('single-text-block messages emit `content` only (no `blocks`)', () => {
    const msg = makeMessage({ content: 'hi', blocks: [textBlock('hi')] });
    const out = serializeMessage(msg);
    expect(out.content).toBe('hi');
    expect(out).not.toHaveProperty('blocks');
  });

  it('messages with empty blocks emit `content` only', () => {
    const msg = makeMessage({ content: 'plain', blocks: [] });
    const out = serializeMessage(msg);
    expect(out.content).toBe('plain');
    expect(out).not.toHaveProperty('blocks');
  });

  it('preset has no effect on pure-text messages', () => {
    const msg = makeMessage({ content: 'hi', blocks: [textBlock('hi')] });
    for (const preset of ['minimal', 'standard', 'verbose', 'full'] as const) {
      const out = serializeMessage(msg, { preset });
      expect(out.content, `preset=${preset}`).toBe('hi');
      expect(out, `preset=${preset}`).not.toHaveProperty('blocks');
    }
  });
});

// ── 2. Rich messages: preset-aware channel selection (oc/12 + oc/13) ──────

describe('serializeMessage — rich-message channel routing', () => {
  const richMsg = (): NormalizedMessage =>
    makeMessage({
      role: 'tool_use',
      content: 'truncated tool name',
      blocks: [toolUseBlock('exec_command', 'call_xyz', { cmd: 'ls' })],
    });

  it('minimal preset → `content` only (no blocks)', () => {
    const out = serializeMessage(richMsg(), { preset: 'minimal' });
    expect(out.content).toBe('truncated tool name');
    expect(out).not.toHaveProperty('blocks');
  });

  it('standard preset → `content` only (no blocks)', () => {
    const out = serializeMessage(richMsg(), { preset: 'standard' });
    expect(out.content).toBe('truncated tool name');
    expect(out).not.toHaveProperty('blocks');
  });

  it('verbose preset → `blocks` only (no content)', () => {
    const out = serializeMessage(richMsg(), { preset: 'verbose' });
    expect(out).toHaveProperty('blocks');
    expect(out).not.toHaveProperty('content');
  });

  it('full preset → `blocks` only (no content)', () => {
    const out = serializeMessage(richMsg(), { preset: 'full' });
    expect(out).toHaveProperty('blocks');
    expect(out).not.toHaveProperty('content');
  });

  it('default (no preset) → `blocks` only (the new safe default)', () => {
    const out = serializeMessage(richMsg());
    expect(out).toHaveProperty('blocks');
    expect(out).not.toHaveProperty('content');
  });

  it('back-compat: passing a bare preset string still routes correctly', () => {
    // Legacy call sites may have used the shorthand serializeMessage(m, 'verbose').
    const out = serializeMessage(richMsg(), 'verbose');
    expect(out).toHaveProperty('blocks');
    expect(out).not.toHaveProperty('content');
  });

  it('multi-block thinking + text → routed per preset', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'visible text',
      blocks: [
        { type: 'thinking', text: 'inner monologue' },
        textBlock('visible text'),
      ],
    });
    const minimal = serializeMessage(msg, { preset: 'minimal' });
    expect(minimal.content).toBe('visible text');
    expect(minimal).not.toHaveProperty('blocks');

    const verbose = serializeMessage(msg, { preset: 'verbose' });
    expect(verbose).not.toHaveProperty('content');
    expect(verbose).toHaveProperty('blocks');
  });
});

// ── 3. detail=meta: tool identity preserved (M3) ──────────────────────────

describe('serializeMessage — detail=meta tool identity (M3)', () => {
  it('tool_use → content = "Tool: <name>" with tool_use_id', () => {
    const msg = makeMessage({
      role: 'tool_use',
      content: 'whatever',
      blocks: [toolUseBlock('exec_command', 'call_42', { cmd: 'pwd' })],
    });
    const out = serializeMessage(msg, { detail: 'meta' });
    expect(out.content).toBe('Tool: exec_command');
    expect(out.tool_use_id).toBe('call_42');
    expect(out).not.toHaveProperty('blocks');
  });

  it('tool_result → tool_use_id surfaces even without a tool name', () => {
    const msg = makeMessage({
      role: 'tool_result',
      content: 'stdout output here',
      blocks: [toolResultBlock('call_42', 'stdout output here', false)],
    });
    const out = serializeMessage(msg, { detail: 'meta' });
    expect(out.tool_use_id).toBe('call_42');
    // No tool name available on tool_result blocks — content collapses
    // to the empty string so callers can distinguish "intentionally
    // hidden" from "no identity available".
    expect(out.content).toBe('');
    expect(out).not.toHaveProperty('blocks');
  });

  it('non-tool roles in meta mode → content blanked, no tool_use_id', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'a long assistant message that should be hidden in meta mode',
      blocks: [textBlock('a long assistant message that should be hidden in meta mode')],
    });
    const out = serializeMessage(msg, { detail: 'meta' });
    expect(out.content).toBe('');
    expect(out).not.toHaveProperty('blocks');
    expect(out).not.toHaveProperty('tool_use_id');
  });

  it('detail=meta overrides preset (preset is irrelevant in meta mode)', () => {
    const msg = makeMessage({
      role: 'tool_use',
      content: 'whatever',
      blocks: [toolUseBlock('grep', 'call_99', {})],
    });
    const out = serializeMessage(msg, { detail: 'meta', preset: 'verbose' });
    expect(out.content).toBe('Tool: grep');
    expect(out).not.toHaveProperty('blocks');
  });
});

// ── 4. Shared metadata: index/role/timestamp/tokens_estimate always present ─

describe('serializeMessage — invariant metadata', () => {
  it('every emission carries index/role/timestamp/tokens_estimate', () => {
    const msg = makeMessage({
      index: 7,
      role: 'assistant',
      timestamp: new Date('2026-05-27T01:02:03.000Z'),
      content: 'ok',
      blocks: [textBlock('ok')],
    });
    const out = serializeMessage(msg, { preset: 'standard' });
    expect(out.index).toBe(7);
    expect(out.role).toBe('assistant');
    expect(out.timestamp).toBeInstanceOf(Date);
    expect(typeof out.tokens_estimate).toBe('number');
  });
});

// ── 5. toExternal: camelCase → snake_case + Date → ISO ────────────────────

describe('toExternal — key rename + date normalization', () => {
  it('renames known camelCase keys', () => {
    const out = toExternal({
      byRole: { toolUse: 3, toolResult: 4 },
      tokenUsage: { input: 100, cacheRead: 50, cacheCreation: 10 },
      filesModified: ['a.ts'],
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    }) as Record<string, unknown>;
    expect(out.by_role).toEqual({ tool_use: 3, tool_result: 4 });
    const usage = out.token_usage as Record<string, unknown>;
    expect(usage.cache_read).toBe(50);
    expect(usage.cache_creation).toBe(10);
    expect(out.files_modified).toEqual(['a.ts']);
    expect(out.created_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('walks arrays and nested objects', () => {
    const out = toExternal([
      { fileBytes: 1, isError: false },
      { fileBytes: 2, isError: true },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].file_bytes).toBe(1);
    expect(out[0].is_error).toBe(false);
    expect(out[1].file_bytes).toBe(2);
  });

  it('passes through unknown keys unchanged', () => {
    const out = toExternal({ id: 'sess_abc', custom_field: 42 }) as Record<string, unknown>;
    expect(out.id).toBe('sess_abc');
    expect(out.custom_field).toBe(42);
  });

  it('converts Date instances anywhere in the tree to ISO strings', () => {
    const d = new Date('2026-05-27T00:00:00.000Z');
    const out = toExternal({ when: d, nested: [{ when: d }] }) as Record<string, unknown>;
    expect(out.when).toBe('2026-05-27T00:00:00.000Z');
    expect((out.nested as Array<{ when: string }>)[0].when).toBe('2026-05-27T00:00:00.000Z');
  });

  it('leaves primitives unchanged', () => {
    expect(toExternal(null)).toBe(null);
    expect(toExternal('hello')).toBe('hello');
    expect(toExternal(42)).toBe(42);
    expect(toExternal(false)).toBe(false);
  });
});

describe('toExternalSession — strips messages + applies toExternal', () => {
  it('removes the raw `messages` array and renames camelCase keys', () => {
    const session: NormalizedSession = {
      id: 'sess_abc',
      source: 'claude',
      filePath: '/tmp/x.jsonl',
      metadata: {
        cwd: '/repo',
        gitBranch: 'main',
        gitRepo: 'github.com/x/y',
        model: 'claude-opus',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        fileBytes: 1024,
        rawLineCount: 10,
      },
      messages: [makeMessage({ index: 1 })],
      stats: {
        totalMessages: 1,
        byRole: { user: 1, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
        byBlockType: { text: 1 },
        toolFrequency: [],
        filesModified: [],
      },
    };
    const out = toExternalSession(session);
    expect(out.messages).toBeUndefined();
    expect(out.file_path).toBe('/tmp/x.jsonl');
    const metadata = out.metadata as Record<string, unknown>;
    expect(metadata.git_branch).toBe('main');
    expect(metadata.created_at).toBe('2026-01-01T00:00:00.000Z');
    const stats = out.stats as Record<string, unknown>;
    expect((stats.by_role as Record<string, unknown>).tool_use).toBe(0);
  });
});
