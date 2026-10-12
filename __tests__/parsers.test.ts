import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { parseCodexSession } from '../src/parsers/codex.js';
import { parseClaudeSession } from '../src/parsers/claude.js';
import { parseFactorySession } from '../src/parsers/factory.js';
import { getAdapter, resolveSourceAlias } from '../src/parsers/registry.js';
import '../src/parsers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_FIXTURE = path.join(__dirname, 'fixtures', 'codex-session.jsonl');
const CLAUDE_FIXTURE = path.join(__dirname, 'fixtures', 'claude-session.jsonl');
const FACTORY_FIXTURE = path.join(__dirname, 'fixtures', 'factory-session.jsonl');

describe('Codex parser', () => {
  it('parses a session file', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.source).toBe('codex');
    expect(session.metadata.cwd).toBe('/home/user/project');
    expect(session.metadata.model).toBe('gpt-5.4');
    expect(session.metadata.gitBranch).toBe('main');
    expect(session.metadata.gitRepo).toContain('github.com/user/project');
  });

  it('extracts normalized messages with correct roles', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.stats.totalMessages).toBeGreaterThan(0);
    expect(session.stats.byRole.user).toBeGreaterThanOrEqual(2);
    expect(session.stats.byRole.assistant).toBeGreaterThanOrEqual(3);
    expect(session.stats.byRole.toolUse).toBeGreaterThanOrEqual(2);
    expect(session.stats.byRole.toolResult).toBeGreaterThanOrEqual(2);
  });

  it('extracts tool frequency', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    const execCmd = session.stats.toolFrequency.find((t) => t.name === 'exec_command');
    expect(execCmd).toBeDefined();
    expect(execCmd!.count).toBeGreaterThanOrEqual(2);
  });

  it('detects tool errors', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    const execCmd = session.stats.toolFrequency.find((t) => t.name === 'exec_command');
    expect(execCmd).toBeDefined();
    expect(execCmd!.errors).toBeGreaterThanOrEqual(1);
  });

  it('extracts files modified from apply_patch', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.stats.filesModified).toContain('src/auth.ts');
  });

  it('aggregates token usage', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.stats.tokenUsage).toBeDefined();
    expect(session.stats.tokenUsage!.input).toBe(1500);
    expect(session.stats.tokenUsage!.output).toBe(350);
  });

  it('computes session duration', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.stats.durationMs).toBeGreaterThan(0);
  });

  it('assigns 1-based indices to messages', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    expect(session.messages[0].index).toBe(1);
    for (let i = 0; i < session.messages.length; i++) {
      expect(session.messages[i].index).toBe(i + 1);
    }
  });

  it('skips system-injected user messages', async () => {
    const session = await parseCodexSession(CODEX_FIXTURE);
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    for (const msg of userMsgs) {
      expect(msg.content).not.toMatch(/^<environment_context>/);
      expect(msg.content).not.toMatch(/^<permissions/);
      expect(msg.content).not.toMatch(/^# AGENTS\.md/);
    }
  });
});

describe('Claude parser', () => {
  it('parses a session file', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.source).toBe('claude');
    expect(session.metadata.cwd).toBe('/home/user/project');
    expect(session.metadata.model).toBe('claude-opus-4-6');
    expect(session.metadata.gitBranch).toBe('main');
  });

  it('extracts session ID from messages', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.id).toBe('test-claude-uuid-5678');
  });

  it('extracts normalized messages with correct roles', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.stats.totalMessages).toBeGreaterThan(0);
    expect(session.stats.byRole.user).toBeGreaterThanOrEqual(2);
    expect(session.stats.byRole.assistant).toBeGreaterThanOrEqual(3);
    expect(session.stats.byRole.toolUse).toBeGreaterThanOrEqual(3);
    expect(session.stats.byRole.toolResult).toBeGreaterThanOrEqual(3);
  });

  it('explodes tool_use blocks into separate messages', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    const toolUses = session.messages.filter((m) => m.role === 'tool_use');
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    for (const tu of toolUses) {
      expect(tu.blocks.length).toBe(1);
      expect(tu.blocks[0].type).toBe('tool_use');
    }
  });

  it('explodes tool_result blocks into separate messages', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    const toolResults = session.messages.filter((m) => m.role === 'tool_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(3);
    for (const tr of toolResults) {
      expect(tr.blocks.length).toBe(1);
      expect(tr.blocks[0].type).toBe('tool_result');
    }
  });

  it('extracts tool frequency', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    const readTool = session.stats.toolFrequency.find((t) => t.name === 'Read');
    const editTool = session.stats.toolFrequency.find((t) => t.name === 'Edit');
    const bashTool = session.stats.toolFrequency.find((t) => t.name === 'Bash');
    expect(readTool).toBeDefined();
    expect(editTool).toBeDefined();
    expect(bashTool).toBeDefined();
  });

  it('extracts files modified from Edit tool', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.stats.filesModified).toContain('src/auth.ts');
  });

  it('aggregates token usage including cache tokens', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.stats.tokenUsage).toBeDefined();
    expect(session.stats.tokenUsage!.input).toBeGreaterThan(0);
    expect(session.stats.tokenUsage!.output).toBeGreaterThan(0);
    expect(session.stats.tokenUsage!.cacheCreation).toBe(500);
    expect(session.stats.tokenUsage!.cacheRead).toBe(200);
  });

  it('skips system-injected user messages (starting with <)', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    for (const msg of userMsgs) {
      expect(msg.content).not.toMatch(/^<environment_context>/);
    }
  });

  it('includes thinking blocks in content block counts', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.stats.byBlockType['thinking']).toBeGreaterThanOrEqual(1);
  });

  it('assigns sequential 1-based indices', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    for (let i = 0; i < session.messages.length; i++) {
      expect(session.messages[i].index).toBe(i + 1);
    }
  });

  it('computes session duration', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    expect(session.stats.durationMs).toBeGreaterThan(0);
  });

  it('preserves user messages starting with / (slash commands are not system-injected)', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    const slashMsg = userMsgs.find((m) => m.content.startsWith('/review'));
    expect(slashMsg).toBeDefined();
    expect(slashMsg!.content).toBe('/review src/auth.ts');
  });

  it('derives createdAt from first raw event, not first filtered message', async () => {
    const session = await parseClaudeSession(CLAUDE_FIXTURE);
    // First raw line is the isMeta system event at 10:00:00, which gets skipped
    // as a message but should still anchor createdAt
    expect(session.metadata.createdAt).toEqual(new Date('2026-01-15T10:00:00.000Z'));
  });
});

describe('Factory parser', () => {
  it('parses a session file with metadata from session_start + sidecar', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.source).toBe('factory');
    expect(session.id).toBe('test-factory-uuid-9999');
    expect(session.metadata.cwd).toBe('/home/user/project');
    expect(session.metadata.model).toBe('custom:GPT-5.5-(low)');
  });

  it('extracts normalized messages with correct roles', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.stats.totalMessages).toBeGreaterThan(0);
    expect(session.stats.byRole.user).toBeGreaterThanOrEqual(2);
    expect(session.stats.byRole.assistant).toBeGreaterThanOrEqual(3);
    expect(session.stats.byRole.toolUse).toBeGreaterThanOrEqual(3);
    expect(session.stats.byRole.toolResult).toBeGreaterThanOrEqual(3);
  });

  it('explodes tool_use blocks into separate messages', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    const toolUses = session.messages.filter((m) => m.role === 'tool_use');
    expect(toolUses.length).toBeGreaterThanOrEqual(3);
    for (const tu of toolUses) {
      expect(tu.blocks.length).toBe(1);
      expect(tu.blocks[0].type).toBe('tool_use');
    }
  });

  it('extracts tool frequency including Read, ApplyPatch, Execute', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.stats.toolFrequency.find((t) => t.name === 'Read')).toBeDefined();
    expect(session.stats.toolFrequency.find((t) => t.name === 'ApplyPatch')).toBeDefined();
    expect(session.stats.toolFrequency.find((t) => t.name === 'Execute')).toBeDefined();
  });

  it('extracts files modified from ApplyPatch input.input', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.stats.filesModified).toContain('src/auth.ts');
  });

  it('aggregates token usage from sidecar .settings.json', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.stats.tokenUsage).toBeDefined();
    expect(session.stats.tokenUsage!.input).toBe(1200);
    expect(session.stats.tokenUsage!.output).toBe(250);
    expect(session.stats.tokenUsage!.cacheRead).toBe(800);
    expect(session.stats.tokenUsage!.cacheCreation).toBe(500);
  });

  it('skips todo_state and compaction_state events from message stream', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    for (const msg of session.messages) {
      expect(msg.content).not.toMatch(/Patch auth\.ts/);
      expect(msg.content).not.toMatch(/User asked to fix login bug/);
    }
  });

  it('skips user messages with visibility: hidden', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    for (const msg of session.messages) {
      expect(msg.content).not.toMatch(/<system-reminder>/);
      expect(msg.content).not.toMatch(/Available tools:/);
    }
  });

  it('spans createdAt and updatedAt across all events including skipped ones', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    // First message event timestamp is 09:00:00 (hidden user); first visible is 09:00:01.
    // The metadata window should reflect the raw event span, not just visible messages.
    expect(session.metadata.createdAt).toEqual(new Date('2026-02-10T09:00:00.000Z'));
    expect(session.metadata.updatedAt).toEqual(new Date('2026-02-10T09:00:11.000Z'));
  });

  it('assigns sequential 1-based indices', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    for (let i = 0; i < session.messages.length; i++) {
      expect(session.messages[i].index).toBe(i + 1);
    }
  });

  it('computes session duration', async () => {
    const session = await parseFactorySession(FACTORY_FIXTURE);
    expect(session.stats.durationMs).toBeGreaterThan(0);
  });
});

describe('Source aliases', () => {
  it("resolves 'droid' to 'factory'", () => {
    expect(resolveSourceAlias('droid')).toBe('factory');
  });

  it("passes 'factory' through unchanged", () => {
    expect(resolveSourceAlias('factory')).toBe('factory');
  });

  it('returns undefined for empty input', () => {
    expect(resolveSourceAlias(undefined)).toBeUndefined();
  });

  it("getAdapter('droid') returns the Factory adapter", () => {
    const adapter = getAdapter('droid');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('factory');
  });

  it("getAdapter('factory') returns the Factory adapter", () => {
    const adapter = getAdapter('factory');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('factory');
  });
});

describe('Claude mid-turn absorbed commands and turn duration (Issue #14)', () => {
  it('ingests queued_command attachment mid-turn and captures turn_duration for durationMs', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: 'run the tests' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 5' } }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-01T00:00:03.000Z', content: 'also run the linter' }),
      JSON.stringify({ type: 'attachment', uuid: 'x1', timestamp: '2026-01-01T00:00:04.000Z', attachment: { type: 'queued_command', prompt: 'also run the linter', commandMode: 'prompt', origin: { kind: 'human' } } }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: '2026-01-01T00:00:04.000Z', content: 'also run the linter', reason: 'absorbed_mid_turn' }),
      JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done, tests and linter ran' }] } }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 's1', timestamp: '2026-01-01T00:00:07.000Z', durationMs: 6000 }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-issue-14-'));
    const filePath = path.join(tmpDir, 'test-synth-14.jsonl');
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    try {
      const session = await parseClaudeSession(filePath);

      // Acceptance: yields two user messages ('run the tests', then 'also run the linter' marked as absorbed mid-turn)
      const userMsgs = session.messages.filter((m) => m.role === 'user');
      expect(userMsgs.length).toBe(2);
      expect(userMsgs[0].content).toBe('run the tests');
      expect(userMsgs[1].content).toBe('also run the linter');
      expect(userMsgs[1].source).toBe('queued');

      // Acceptance: turn end with durationMs: 6000
      expect(session.stats.durationMs).toBe(6000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


async function parseReview21Records(records: unknown[], raw?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-review-21-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, raw ?? records.map((r) => JSON.stringify(r)).join('\n'));
  try { return await parseClaudeSession(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function review21Attachment(uuid: string, attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'attachment', uuid, timestamp: '2026-01-01T00:00:04Z', ...extra, attachment: { type: 'queued_command', prompt: 'steer', ...attachment } };
}

it('21-A accepts prompt and absent modes but never treats notifications as human steers', async () => {
  const session = await parseReview21Records([
    review21Attachment('prompt', { commandMode: 'prompt', origin: { kind: 'human' } }),
    review21Attachment('legacy', { origin: { kind: 'human' } }),
    review21Attachment('notification', { commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } }),
  ]);
  expect(session.messages.filter((m) => m.role === 'user').map((m) => m.source)).toEqual(['queued', 'queued']);
  expect(session.stats.byRole.user).toBe(2);
  expect(session.messages[2]).toMatchObject({ role: 'system', source: 'task_notification' });
});
