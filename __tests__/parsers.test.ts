import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseCodexSession } from '../src/parsers/codex.js';
import { parseClaudeSession } from '../src/parsers/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_FIXTURE = path.join(__dirname, 'fixtures', 'codex-session.jsonl');
const CLAUDE_FIXTURE = path.join(__dirname, 'fixtures', 'claude-session.jsonl');

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
