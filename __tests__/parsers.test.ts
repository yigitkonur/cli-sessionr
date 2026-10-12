import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { parseCodexSession, unrollCodexExec, extractFilesFromPatch, parseToolOutputError } from '../src/parsers/codex.js';
import { parseClaudeSession } from '../src/parsers/claude.js';
import { parseFactorySession } from '../src/parsers/factory.js';
import { getAdapter, resolveSourceAlias } from '../src/parsers/registry.js';
import '../src/parsers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_FIXTURE = path.join(__dirname, 'fixtures', 'codex-session.jsonl');
const CODEX_EXEC_FIXTURE = path.join(__dirname, 'fixtures', 'codex-exec-session.jsonl');
const E2E_CODEX_EXEC_PATCH_FIXTURE = path.join(__dirname, 'fixtures', 'e2e-codex-exec-patch.jsonl');
const CODEX_EXEC_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/service.ts',
  '+export const ok = true;',
  '+export const version = "1.0.0";',
  '+export const description = "Service module that wires the session index to the exported API surface and keeps the public contract stable across releases";',
  '*** Update File: src/index.ts',
  '@@',
  "+export * from './service.js';",
  '*** End Patch',
].join('\n');
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

describe('Milestone 1: Codex Deep Tool & Patch Parsing (Issue #7)', () => {
  it('unrolls custom_tool_call exec into exec_command with full command', async () => {
    const session = await parseCodexSession(CODEX_EXEC_FIXTURE);
    const execMsg = session.messages.find(
      (m) => m.role === 'tool_use' && m.blocks[0].name === 'exec_command',
    );
    expect(execMsg).toBeDefined();
    expect(execMsg!.blocks[0].input.cmd).toBe('pnpm test');
    expect(execMsg!.blocks[0].input.workdir).toBe('/app');
    expect(execMsg!.content).toBe('Tool: exec_command');
  });

  it('unrolls custom_tool_call exec into apply_patch with untruncated patch', async () => {
    const session = await parseCodexSession(CODEX_EXEC_FIXTURE);
    const patchMsg = session.messages.find(
      (m) => m.role === 'tool_use' && m.blocks[0].name === 'apply_patch',
    );
    expect(patchMsg).toBeDefined();
    const patchInput = String(patchMsg!.blocks[0].input.patch || '');
    expect(CODEX_EXEC_PATCH.length).toBeGreaterThan(300);
    expect(patchInput).toBe(CODEX_EXEC_PATCH);
    expect(patchMsg!.content).toBe('Tool: apply_patch');
  });

  it('extracts files modified from unrolled apply_patch headers into stats.filesModified', async () => {
    const session = await parseCodexSession(CODEX_EXEC_FIXTURE);
    expect(session.stats.filesModified).toContain('src/service.ts');
    expect(session.stats.filesModified).toContain('src/index.ts');
  });

  it('detects tool error from result JSON exit_code !== 0', async () => {
    const session = await parseCodexSession(CODEX_EXEC_FIXTURE);
    const results = session.messages.filter((m) => m.role === 'tool_result');
    expect(results.length).toBe(2);

    // First tool result (exit_code: 1) is flagged as error
    const errResult = results[0];
    expect(errResult.blocks[0].isError).toBe(true);

    // Second tool result (exit_code: 0) is flagged as success
    const okResult = results[1];
    expect(okResult.blocks[0].isError).toBe(false);

    // Tool error count attributed in stats.toolFrequency
    const execFreq = session.stats.toolFrequency.find((t) => t.name === 'exec_command');
    expect(execFreq).toBeDefined();
    expect(execFreq!.errors).toBe(1);

    const patchFreq = session.stats.toolFrequency.find((t) => t.name === 'apply_patch');
    expect(patchFreq).toBeDefined();
    expect(patchFreq!.errors).toBe(0);
  });

  it('handles e2e-codex-exec-patch fixture with structured JSON exec and file modifications', async () => {
    const session = await parseCodexSession(E2E_CODEX_EXEC_PATCH_FIXTURE);
    expect(session.source).toBe('codex');
    expect(session.stats.filesModified).toContain('src/auth-helper.ts');
    expect(session.stats.filesModified).toContain('src/index.ts');
    expect(session.stats.filesModified).toContain('src/legacy-auth.ts');

    // Tool calls unrolled
    const toolUses = session.messages.filter((m) => m.role === 'tool_use');
    expect(toolUses.some((t) => t.blocks[0].name === 'exec_command')).toBe(true);
    expect(toolUses.some((t) => t.blocks[0].name === 'apply_patch')).toBe(true);

    // Error detected on locked file delete (exit_code: 1)
    const toolResults = session.messages.filter((m) => m.role === 'tool_result');
    expect(toolResults.some((r) => r.blocks[0].isError === true)).toBe(true);
    expect(toolResults.some((r) => r.blocks[0].isError === false)).toBe(true);
  });

  it('preserves untruncated commands exceeding 300 characters in tool input', () => {
    const longCmd = 'curl -X POST https://api.example.com/v1/deploy ' + 'a'.repeat(400);
    const jsSnippet = `const r = await tools.exec_command({ cmd: "${longCmd}" });\ntext(r.output);`;
    const unrolled = unrollCodexExec(jsSnippet);
    expect(unrolled.toolName).toBe('exec_command');
    expect(unrolled.args.cmd).toBe(longCmd);
    expect((unrolled.args.cmd as string).length).toBeGreaterThan(400);
  });

  it('unescapes single quotes with \\\' cleanly in exec_command', () => {
    const input = "const r = await tools.exec_command({ cmd: 'echo \\'hello world\\'' });";
    const unrolled = unrollCodexExec(input);
    expect(unrolled.toolName).toBe('exec_command');
    expect(unrolled.args.cmd).toBe("echo 'hello world'");

    const inputMultiple = "const r = await tools.exec_command({ cmd: 'echo \\'first\\' && echo \\'second\\'' });";
    const unrolledMultiple = unrollCodexExec(inputMultiple);
    expect(unrolledMultiple.args.cmd).toBe("echo 'first' && echo 'second'");
  });

  it('extracts all modified files when patch code contains quotes and semicolons', async () => {
    const sessionLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-03-01T10:00:00Z', payload: { id: 'test-trunc', cwd: '/app' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:01Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c1',
          input: 'await tools.apply_patch("*** Add File: src/one.ts\\n+const x = \\"foo\\";\\n*** Update File: src/two.ts\\n+const y = 2;");',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:02Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c1',
          output: { exit_code: 0 },
        },
      }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-test-codex-'));
    const filePath = path.join(tmpDir, 'test-trunc.jsonl');
    fs.writeFileSync(filePath, sessionLines.join('\n') + '\n', 'utf8');

    try {
      const s = await parseCodexSession(filePath);
      expect(s.stats.filesModified).toContain('src/one.ts');
      expect(s.stats.filesModified).toContain('src/two.ts');
      expect(s.stats.filesModified.length).toBe(2);

      const toolUseMsg = s.messages.find((m) => m.role === 'tool_use');
      expect(toolUseMsg).toBeDefined();
      const patchInput = (toolUseMsg!.blocks[0] as any).input.patch;
      expect(patchInput).toContain('src/one.ts');
      expect(patchInput).toContain('src/two.ts');
      expect(patchInput).toContain('+const x = "foo";');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports arbitrary variable names and template literals in apply_patch', async () => {
    const sessionLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-03-01T10:00:00Z', payload: { id: 'test-var-patch', cwd: '/app' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:01Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c2',
          input: 'const diff = `*** Add File: src/alpha.ts\\n+export const a = "quoted;";\\n*** Update File: src/beta.ts\\n+const b = true;`;\\nawait tools.apply_patch(diff);',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:02Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c2',
          output: { exit_code: 0 },
        },
      }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-test-codex-'));
    const filePath = path.join(tmpDir, 'test-var.jsonl');
    fs.writeFileSync(filePath, sessionLines.join('\n') + '\n', 'utf8');

    try {
      const s = await parseCodexSession(filePath);
      expect(s.stats.filesModified).toContain('src/alpha.ts');
      expect(s.stats.filesModified).toContain('src/beta.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts clean file paths without backticks from template literal patch variables without trailing newlines', async () => {
    // 1. Unroll test: patch string must not retain outer backticks
    const rawSnippet = 'const diff = `*** Add File: src/one.ts\n+1\n*** Add File: src/two.ts`;\nawait tools.apply_patch(diff);';
    const unrolled = unrollCodexExec(rawSnippet);
    expect(unrolled.toolName).toBe('apply_patch');
    const patchStr = unrolled.args.patch as string;
    expect(patchStr.startsWith('`')).toBe(false);
    expect(patchStr.endsWith('`')).toBe(false);

    // 2. Direct extraction from patch string without trailing newline
    const files = extractFilesFromPatch(patchStr);
    expect(files).toEqual(['src/one.ts', 'src/two.ts']);
    expect(files).not.toContain('src/two.ts`');

    // 3. Full session parsing with single and multi-file template literals without trailing newlines
    const sessionLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-03-01T10:00:00Z', payload: { id: 'test-no-newline-patch', cwd: '/app' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:01Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c-tl1',
          input: 'const patchVar = `*** Add File: src/alpha.ts\\n+line\\n*** Add File: src/beta.ts`;\\nawait tools.apply_patch(patchVar);',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:02Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c-tl1',
          output: { exit_code: 0 },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:03Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c-tl2',
          input: 'const p = `*** Delete File: src/obsolete.ts`;\\nawait tools.apply_patch(p);',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:04Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c-tl2',
          output: { exit_code: 0 },
        },
      }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-test-codex-'));
    const filePath = path.join(tmpDir, 'test-tl.jsonl');
    fs.writeFileSync(filePath, sessionLines.join('\n') + '\n', 'utf8');

    try {
      const s = await parseCodexSession(filePath);
      expect(s.stats.filesModified).toContain('src/alpha.ts');
      expect(s.stats.filesModified).toContain('src/beta.ts');
      expect(s.stats.filesModified).toContain('src/obsolete.ts');
      expect(s.stats.filesModified).not.toContain('src/beta.ts`');
      expect(s.stats.filesModified).not.toContain('src/obsolete.ts`');
      for (const file of s.stats.filesModified) {
        expect(file.endsWith('`')).toBe(false);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts files modified from git diff headers in apply_patch', async () => {
    const sessionLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-03-01T10:00:00Z', payload: { id: 'test-gitdiff', cwd: '/app' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:01Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c3',
          input: JSON.stringify({
            tool: 'apply_patch',
            patch: 'diff --git a/src/test.ts b/src/test.ts\n--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1,1 +1,2 @@\n-old\n+new',
          }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-03-01T10:00:02Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c3',
          output: { exit_code: 0 },
        },
      }),
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-test-codex-'));
    const filePath = path.join(tmpDir, 'test-gitdiff.jsonl');
    fs.writeFileSync(filePath, sessionLines.join('\n') + '\n', 'utf8');

    try {
      const s = await parseCodexSession(filePath);
      expect(s.stats.filesModified).toEqual(['src/test.ts']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extractFilesFromPatch handles git diff headers, new/deleted files with /dev/null, and colon-less headers', () => {
    const patchContent = [
      '*** Add File src/new-without-colon.ts',
      '+content',
      '*** Update File: src/updated-with-colon.ts',
      '+content',
      'diff --git a/src/git-modified.ts b/src/git-modified.ts',
      '--- a/src/git-modified.ts',
      '+++ b/src/git-modified.ts',
      '@@ -1 +1 @@',
      'diff --git a/src/created.ts b/src/created.ts',
      '--- /dev/null',
      '+++ b/src/created.ts',
      '@@ -0,0 +1 @@',
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n');

    const files = extractFilesFromPatch(patchContent);
    expect(files).toContain('src/new-without-colon.ts');
    expect(files).toContain('src/updated-with-colon.ts');
    expect(files).toContain('src/git-modified.ts');
    expect(files).toContain('src/created.ts');
    expect(files).toContain('src/deleted.ts');
    expect(files).not.toContain('/dev/null');
    expect(files).not.toContain('dev/null');
    expect(files.length).toBe(5);
  });
});


// Cases copied from the PR #18 review's numbered regression records.
const CODEX_REGRESSIONS = path.join(__dirname, 'fixtures', 'codex-exec-regressions.jsonl');
const regressionRecords = fs.readFileSync(CODEX_REGRESSIONS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
function regressionCall(id: string) {
  return regressionRecords.find((record) => record.payload?.call_id === id && record.payload.type === 'custom_tool_call').payload;
}
async function regressionSession(id: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionr-codex-regression-'));
  const file = path.join(tmpDir, 'regression.jsonl');
  const records = regressionRecords.filter((record) => record.type === 'session_meta' || record.payload?.call_id === id);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));
  try {
    return await parseCodexSession(file);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Codex exec review regressions', () => {
  it.each(['nested-error', 'later-array-error', 'metadata-error', 'plain-exit-error'])('F1 detects %s and attributes the failure', async (id) => {
    const session = await regressionSession(id);
    const result = session.messages.find((message) => message.role === 'tool_result')!.blocks[0];
    expect(result.isError).toBe(true);
    expect(session.stats.toolFrequency).toEqual([{ name: 'exec_command', count: 1, errors: 1 }]);
    const output = regressionRecords.find((record) => record.payload?.call_id === id && record.payload.type === 'custom_tool_call_output').payload.output;
    expect(result.content).toBe(typeof output === 'string' ? output : JSON.stringify(output));
  });

  it('F1 detects Script failed prefixes, nested metadata objects and all text blocks', () => {
    expect(parseToolOutputError('Script failed\nOutput: failure')).toBe(true);
    expect(parseToolOutputError({ metadata: { exit_code: 1 } })).toBe(true);
    expect(parseToolOutputError([{ type: 'input_text', text: '{"exit_code":0}' }, { type: 'input_text', text: '{"metadata":{"exit_code":1}}' }])).toBe(true);
    expect(parseToolOutputError('Process exited with code 0\nFinal output:\nok')).toBe(false);
    expect(parseToolOutputError([{ exit_code: 0 }, { type: 'input_text', text: '{"metadata":{"exit_code":0}}' }])).toBe(false);
  });

  it('F1 reproduces the exact later issue #7 comment with one failed command', async () => {
    const session = await parseCodexSession(path.join(__dirname, 'fixtures', 'codex-issue7-repro.jsonl'));
    expect(session.messages.filter((message) => message.role === 'tool_result').map((message) => message.blocks[0].isError)).toEqual([false, true]);
    expect(session.stats.toolFrequency.find((tool) => tool.name === 'exec_command')!.errors).toBe(1);
  });
  it('F2 accepts the quoted cmd key from record 3', () => {
    expect(unrollCodexExec(regressionCall('quoted-key').input).args.cmd).toBe('echo hello');
  });

  it.each(['"cmd"', "'command'"])('F2 preserves long commands with the %s key', (key) => {
    const command = 'echo ' + 'x'.repeat(350);
    expect(unrollCodexExec(`text(await tools.exec_command({${key}:${JSON.stringify(command)}}));`).args.cmd).toBe(command);
  });

  it('F2 reads only the selected invocation and retains opaque commands without an empty cmd', () => {
    const input = 'const unrelated = {cmd:"wrong"}; await tools.exec_command({"cmd":"right"}); await tools.exec_command({cmd:"later"});';
    expect(unrollCodexExec(input).args.cmd).toBe('right');
    const opaque = 'await tools.exec_command({cmd:dynamicCommand}); const unrelated = {cmd:"wrong"};';
    expect(unrollCodexExec(opaque).args).not.toHaveProperty('cmd');
    expect(unrollCodexExec(opaque).args.raw).toBe(opaque);
  });

  it.each(['patch-literal-native', 'patch-literal-wrapper'])('F3 keeps %s as a patch despite tool names in added code', async (id) => {
    const session = await regressionSession(id);
    expect(session.messages[0].blocks[0].name).toBe('apply_patch');
    expect(session.stats.filesModified).toEqual(['generated.js']);
  });

  it('F3 extracts a preceding patch independently of the mixed wrapper summary name', async () => {
    const session = await regressionSession('mixed-inner');
    expect(session.messages[0].blocks[0].name).toBe('exec_command');
    expect(session.messages[0].blocks[0].input.cmd).toBe('cat a.txt');
    expect(session.stats.filesModified).toEqual(['a.txt']);
  });

  it('F3 ignores invocation-looking text inside strings, templates and comments', () => {
    const input = '// tools.exec_command({cmd:"wrong"})\nconst quoted = "tools.exec_command({cmd:wrong})"; const template = `tools.exec_command({cmd:wrong})`; /* tools.exec_command({cmd:"wrong"}) */ await tools.apply_patch("*** Add File: real.txt\\n+tools.exec_command({cmd:wrong})");';
    const result = unrollCodexExec(input);
    expect(result.toolName).toBe('apply_patch');
    expect(result.patchContent).toBe('*** Add File: real.txt\n+tools.exec_command({cmd:wrong})');
    expect(unrollCodexExec('const quoted = "tools.exec_command({cmd:wrong})";').toolName).toBe('exec');
  });

  it('F4 keeps write_stdin and its static session reference from records 5-6', async () => {
    const session = await regressionSession('poll-name');
    expect(session.messages[0].blocks[0].name).toBe('write_stdin');
    expect(session.messages[0].blocks[0].input).toMatchObject({ session_id: 123, chars: '' });
    expect(session.stats.toolFrequency).toEqual([{ name: 'write_stdin', count: 1, errors: 1 }]);
  });

  it('F4 keeps arbitrary inner tool names and static JSON or scalar arguments', () => {
    const plan = { explanation: 'next', plan: [{ step: 'test', status: 'in_progress' }] };
    expect(unrollCodexExec(`await tools.update_plan(${JSON.stringify(plan)});`)).toMatchObject({ toolName: 'update_plan', args: plan });
    expect(unrollCodexExec('await tools.other_tool({count:2, enabled:true, value:null, label:"a,b", dynamic:compute()});')).toMatchObject({ toolName: 'other_tool', args: { count: 2, enabled: true, value: null, label: 'a,b' } });
  });

  it.each([
    ['git-quoted', ['src/with space.ts']],
    ['real-a-directory', ['a/test.txt']],
    ['hunk-path-false-positive', ['real.txt']],
    ['null-path', ['null']],
    ['comma-path', ['name,']],
  ])('F5 preserves exact file paths for %s', async (id, files) => {
    expect((await regressionSession(id as string)).stats.filesModified).toEqual(files);
  });

  it('F5 strips exactly one git-side prefix and drops only diff null sentinels', () => {
    expect(extractFilesFromPatch('diff --git "a/a/my file.txt" "b/a/my file.txt"\n--- /dev/null\n+++ "b/a/my file.txt"\n@@ -0,0 +1 @@\n+x')).toEqual(['a/my file.txt']);
    expect(extractFilesFromPatch('*** Add File: b/native;\n+x\n*** Add File: /dev/null\n+x')).toEqual(['b/native;', '/dev/null']);
    expect(extractFilesFromPatch('*** Update File: real.txt\n@@\n--- a/bogus\n+++ b/bogus')).toEqual(['real.txt']);
  });

  it('F6 decodes hex and Unicode code point escapes from record 15', () => {
    expect(unrollCodexExec(regressionCall('unicode').input).args.cmd).toBe('echo ab😀');
  });

  it.each([
    ['text(await tools.exec_command({cmd:`echo \\`hello\\``}));', 'echo `hello`'],
    ["text(await tools.exec_command({cmd:'echo he\\\nllo'}));", 'echo hello'],
    ["text(await tools.exec_command({cmd:'echo he\\\r\nllo'}));", 'echo hello'],
    [String.raw`text(await tools.exec_command({cmd:"echo a\x62\u0063\u{1F600}"}));`, 'echo abc😀'],
  ])('F6 decodes JavaScript literal %s without evaluating it', (input, expected) => {
    expect(unrollCodexExec(input).args.cmd).toBe(expected);
  });

  it('F6 shares literal decoding across commands, workdirs and patches', () => {
    const result = unrollCodexExec(String.raw`await tools.exec_command({cmd:'echo \x62',workdir:'C:\\work\u{1F600}'});`);
    expect(result.args.workdir).toBe('C:\\work😀');
    expect(unrollCodexExec(String.raw`await tools.apply_patch('*** Add File: \x62.txt\n+\u{1F600}');`).args.patch).toBe('*** Add File: b.txt\n+😀');
  });

  it.each(['command', 'cmd'])('F7 preserves JSON argv under %s exactly', (key) => {
    const argv = JSON.parse(regressionCall('array-command').input).command;
    const result = unrollCodexExec(JSON.stringify({ [key]: argv }));
    expect(result.toolName).toBe('exec_command');
    expect(result.args.cmd).toEqual(['printf', '%s', 'a b']);
    expect(result.args.command).toEqual(argv);
    expect(unrollCodexExec(JSON.stringify({ [key]: 'echo hello' })).args.cmd).toBe('echo hello');
  });

  it('F7 retains opaque JSON exec input without inventing an empty command', () => {
    const raw = '{"tool":"exec_command","command":{"dynamic":true}}';
    expect(unrollCodexExec(raw).args).not.toHaveProperty('cmd');
    expect(unrollCodexExec(raw).args.raw).toBe(raw);
  });

  it('cubic 4244115926 preserves the full long patch from records 29-30', async () => {
    const patch = '*** Begin Patch\n*** Add File: long.txt\n+' + 'x'.repeat(600) + '\n*** End Patch';
    const session = await regressionSession('long-patch');
    expect(session.messages[0].blocks[0].input.patch).toBe(patch);
  });

  it.each(['direct', 'JSON', 'variable'])('F8 stores one canonical full patch for the %s wrapper', (kind) => {
    const patch = '*** Begin Patch\n*** Add File: long.txt\n+' + 'x'.repeat(600) + '\n*** End Patch';
    const input = kind === 'direct' ? regressionCall('long-patch').input : kind === 'JSON' ? JSON.stringify({ tool: 'apply_patch', patch }) : `const diff = ${JSON.stringify(patch)}; await tools.apply_patch(diff);`;
    const result = unrollCodexExec(input);
    expect(result.patchContent).toBe(patch);
    expect(result.args).toEqual({ patch });
    expect(JSON.stringify(result.args)).toBe(JSON.stringify({ patch }));
  });

  it('cubic 4244115931 uses a fixture patch beyond the truncation boundary with exact equality', async () => {
    const session = await parseCodexSession(CODEX_EXEC_FIXTURE);
    const input = session.messages.find((message) => message.blocks[0].name === 'apply_patch')!.blocks[0].input;
    expect(input.patch).toBe(CODEX_EXEC_PATCH);
    expect((input.patch as string).length).toBeGreaterThan(300);
  });

  it('cubic 4244115973 records a valid Add File section without hunk markers', () => {
    const call = fs.readFileSync(CODEX_EXEC_FIXTURE, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((record) => record.payload?.call_id === 'c2' && record.payload.type === 'custom_tool_call');
    const patch = unrollCodexExec(call.payload.input).args.patch as string;
    const addSection = patch.split('*** Add File: src/service.ts\n')[1].split('*** Update File:')[0];
    expect(addSection).not.toContain('@@');
    expect(addSection.trim().split('\n').every((line) => line.startsWith('+'))).toBe(true);
  });

});
