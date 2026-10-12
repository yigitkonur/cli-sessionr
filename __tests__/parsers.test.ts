import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { parseCodexSession } from '../src/parsers/codex.js';
import { parseClaudeSession, classifyUserSource } from '../src/parsers/claude.js';
import { parseFactorySession } from '../src/parsers/factory.js';
import { getAdapter, resolveSourceAlias } from '../src/parsers/registry.js';
import '../src/parsers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_FIXTURE = path.join(__dirname, 'fixtures', 'codex-session.jsonl');
const CLAUDE_FIXTURE = path.join(__dirname, 'fixtures', 'claude-session.jsonl');
const CLAUDE_HARDENED_FIXTURE = path.join(__dirname, 'fixtures', 'claude-hardened-session.jsonl');
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

describe('Claude message source classification (Issue #16)', () => {
  it('anchors user source classification preventing false positives on human conversational prompts', () => {
    const dummyLine = { type: 'user' } as any;

    // Conversational prompts discussing keywords must be classified as 'prompt'
    expect(classifyUserSource('How do I handle [Request interrupted by user] in my agent loop?', dummyLine)).toBe('prompt');
    expect(classifyUserSource('Can you show me what <task-notification> looks like?', dummyLine)).toBe('prompt');
    expect(classifyUserSource('Is /compact command destructive?', dummyLine)).toBe('prompt');
    expect(classifyUserSource('Why does <command-name> appear in my logs?', dummyLine)).toBe('prompt');
    expect(classifyUserSource('Why does "This session is being continued from a previous conversation" show up?', dummyLine)).toBe('prompt');

    // Genuine system/interrupt/notification/local-command records
    expect(classifyUserSource('[Request interrupted by user]', dummyLine)).toBe('interrupt');
    expect(classifyUserSource('[Request interrupted by user for tool use "Bash"]', dummyLine)).toBe('interrupt');
    expect(classifyUserSource('User interrupted execution', dummyLine)).toBe('interrupt');
    expect(classifyUserSource('<task-notification><task-id>task-1</task-id></task-notification>', dummyLine)).toBe('task_notification');
    expect(classifyUserSource('<command-name>/compact</command-name>', dummyLine)).toBe('local_command');
    expect(classifyUserSource('/compact', dummyLine)).toBe('local_command');
    expect(classifyUserSource('<environment_context>cwd</environment_context>', dummyLine)).toBe('system');
  });

  it('correctly handles the minimal synthetic example from Issue #16', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: 'fix the bug' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u3', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>x</command-args>' } }),
      JSON.stringify({ type: 'user', uuid: 'u4', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user', content: '<local-command-stdout>Set model to x</local-command-stdout>' } }),
      JSON.stringify({ type: 'user', uuid: 'u5', timestamp: '2026-01-01T00:00:06.000Z', promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the background task finished' }] } }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-issue-16-'));
    const filePath = path.join(tmpDir, 'test-synth.jsonl');
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    try {
      const session = await parseClaudeSession(filePath);
      // Exactly 1 genuine human prompt counts in stats.byRole.user
      expect(session.stats.byRole.user).toBe(1);

      // Verify classifications on individual messages
      const u1 = session.messages.find((m) => m.content === 'fix the bug');
      expect(u1).toBeDefined();
      expect(u1!.source).toBe('prompt');

      const u2 = session.messages.find((m) => m.content.includes('[Request interrupted by user]'));
      expect(u2).toBeDefined();
      expect(u2!.source).toBe('interrupt');

      const u3 = session.messages.find((m) => m.content.includes('<command-name>'));
      expect(u3).toBeDefined();
      expect(u3!.source).toBe('local_command');

      const u4 = session.messages.find((m) => m.content.includes('<local-command-stdout>'));
      expect(u4).toBeDefined();
      expect(u4!.source).toBe('local_command');

      const u5 = session.messages.find((m) => m.content.includes('<task-notification>'));
      expect(u5).toBeDefined();
      expect(u5!.source).toBe('task_notification');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('excludes non-human prompts from stats.byRole.user in claude-hardened fixture', async () => {
    const session = await parseClaudeSession(CLAUDE_HARDENED_FIXTURE);
    // Despite having interrupt and local_command messages,
    // only the single genuine human prompt counts towards stats.byRole.user
    expect(session.stats.byRole.user).toBe(1);
    expect(session.messages[0].source).toBe('prompt');
    const interruptMsg = session.messages.find((m) => m.source === 'interrupt');
    expect(interruptMsg).toBeDefined();
    const cmdMsg = session.messages.find((m) => m.source === 'local_command');
    expect(cmdMsg).toBeDefined();
  });
});

