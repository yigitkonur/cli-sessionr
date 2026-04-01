import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { execFileSync } from 'child_process';

import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedSession,
  SessionListEntry,
  SessionMetadata,
  SessionStats,
} from '../types.js';
import { truncate } from './common.js';
import { registerSource } from './registry.js';
import { isSqliteAvailable, queryAll } from './sqlite.js';
import { ParseError } from '../errors.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Separator between DB path and thread ID in synthetic filePath */
const THREAD_SEP = '::';
const MAX_TOOL_RESULT_PREVIEW = 2000;

// ── Platform paths ─────────────────────────────────────────────────────────

function getZedDataPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Zed');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Zed');
    default: // linux
      return path.join(home, '.config', 'Zed');
  }
}

function getZedDbPaths(): string[] {
  const paths = [path.join(getZedDataPath(), 'threads', 'threads.db')];

  // Linux alternative location
  if (process.platform === 'linux') {
    const home = os.homedir();
    paths.push(path.join(home, '.local', 'share', 'Zed', 'threads', 'threads.db'));
  }

  return paths;
}

function findZedDb(): string | null {
  for (const dbPath of getZedDbPaths()) {
    if (fs.existsSync(dbPath)) return dbPath;
  }
  return null;
}

// ── Zstd decompression ─────────────────────────────────────────────────────

function decompressZstd(buffer: Buffer): string {
  // Strategy 1: Node 22+ native zstd support
  try {
    const fn = (zlib as Record<string, unknown>)['zstdDecompressSync'];
    if (typeof fn === 'function') {
      const decompressed = fn(buffer) as Buffer;
      return decompressed.toString('utf-8');
    }
  } catch {
    // Not available or failed — try CLI fallback
  }

  // Strategy 2: zstd CLI via stdin/stdout
  try {
    const result = execFileSync('zstd', ['-d', '--stdout', '-'], {
      input: buffer,
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.toString('utf-8');
  } catch {
    // Both strategies failed
  }

  throw new ParseError(
    'zstd-blob',
    'Zstd decompression not available. Install Node 22+ (built-in zstd) or the zstd CLI tool.',
  );
}

// ── Raw DB row type ────────────────────────────────────────────────────────

interface ThreadRow {
  id: string;
  summary: string | null;
  updated_at: string | null;
  data: Buffer | null;
  data_type: string | null;
  worktree_branch: string | null;
}

// ── Zed thread JSON shapes ─────────────────────────────────────────────────

interface ZedContentBlock {
  Text?: string;
  ToolUse?: { name?: string; input?: unknown; id?: string };
  ToolResult?: { content?: string; tool_use_id?: string; output?: string };
  Thinking?: string | { text?: string };
}

interface ZedMessage {
  User?: { content?: ZedContentBlock[] };
  Agent?: { content?: ZedContentBlock[] };
}

interface ZedThreadData {
  model?: { model?: string };
  messages?: ZedMessage[];
}

// ── Content extraction ─────────────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function extractZedContent(
  content: ZedContentBlock[] | undefined,
  msgIndex: number,
  timestamp: Date,
  role: 'user' | 'assistant',
): ExplodedMessage[] {
  if (!Array.isArray(content)) return [];

  const results: ExplodedMessage[] = [];
  const textBlocks: ContentBlock[] = [];
  let textContent = '';

  for (const block of content) {
    if (block.Text) {
      const text = block.Text;
      if (text.trim()) {
        textBlocks.push({ type: 'text', text });
        textContent += (textContent ? '\n' : '') + text;
      }
    } else if (block.ToolUse) {
      // Flush accumulated text before tool_use
      if (textBlocks.length > 0) {
        results.push({
          role,
          content: textContent,
          blocks: [...textBlocks],
          timestamp,
          rawLineIndex: msgIndex,
        });
        textBlocks.length = 0;
        textContent = '';
      }

      const tu = block.ToolUse;
      const toolName = tu.name || 'unknown';
      let input: Record<string, unknown> = {};
      try {
        input = typeof tu.input === 'string' ? JSON.parse(tu.input) : (tu.input as Record<string, unknown>) || {};
      } catch {
        input = {};
      }

      const toolBlock: ContentBlock = {
        type: 'tool_use',
        id: tu.id || `zed-tool-${msgIndex}`,
        name: toolName,
        input,
      };
      results.push({
        role: 'tool_use',
        content: `Tool: ${toolName}`,
        blocks: [toolBlock],
        timestamp,
        rawLineIndex: msgIndex,
      });
    } else if (block.ToolResult) {
      // Flush accumulated text before tool_result
      if (textBlocks.length > 0) {
        results.push({
          role,
          content: textContent,
          blocks: [...textBlocks],
          timestamp,
          rawLineIndex: msgIndex,
        });
        textBlocks.length = 0;
        textContent = '';
      }

      const tr = block.ToolResult;
      const resultContent = (tr.content || tr.output || '').substring(0, MAX_TOOL_RESULT_PREVIEW);
      const resultBlock: ContentBlock = {
        type: 'tool_result',
        toolUseId: tr.tool_use_id || '',
        content: resultContent,
        isError: false,
      };
      results.push({
        role: 'tool_result',
        content: resultContent,
        blocks: [resultBlock],
        timestamp,
        rawLineIndex: msgIndex,
      });
    } else if (block.Thinking) {
      const text = typeof block.Thinking === 'string'
        ? block.Thinking
        : (block.Thinking.text || '');
      if (text.trim()) {
        textBlocks.push({ type: 'thinking', text });
      }
    }
  }

  // Flush remaining text+thinking blocks
  if (textBlocks.length > 0) {
    results.push({
      role,
      content: textContent,
      blocks: [...textBlocks],
      timestamp,
      rawLineIndex: msgIndex,
    });
  }

  return results;
}

// ── Thread data extraction ─────────────────────────────────────────────────

function parseThreadData(row: ThreadRow): ZedThreadData | null {
  if (!row.data) return null;

  let json: string;
  const dataType = row.data_type || 'zstd';

  try {
    if (dataType === 'zstd') {
      json = decompressZstd(Buffer.from(row.data));
    } else {
      json = Buffer.from(row.data).toString('utf-8');
    }
  } catch (e) {
    if (e instanceof ParseError) throw e;
    return null;
  }

  try {
    return JSON.parse(json) as ZedThreadData;
  } catch {
    return null;
  }
}

// ── Stats computation ──────────────────────────────────────────────────────

function computeStats(messages: NormalizedMessage[]): SessionStats {
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; errors: number }>();

  for (const msg of messages) {
    switch (msg.role) {
      case 'user': byRole.user++; break;
      case 'assistant': byRole.assistant++; break;
      case 'system': byRole.system++; break;
      case 'tool_use': byRole.toolUse++; break;
      case 'tool_result': byRole.toolResult++; break;
    }

    for (const block of msg.blocks) {
      byBlockType[block.type] = (byBlockType[block.type] || 0) + 1;

      if (block.type === 'tool_use') {
        const existing = toolCounts.get(block.name) || { count: 0, errors: 0 };
        existing.count++;
        toolCounts.set(block.name, existing);
      }
    }
  }

  // Track tool errors from tool_result blocks
  const toolUseIdToName = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && block.id) {
        toolUseIdToName.set(block.id, block.name);
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'tool_result') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_result' && block.isError && block.toolUseId) {
          const toolName = toolUseIdToName.get(block.toolUseId);
          if (toolName) {
            const existing = toolCounts.get(toolName);
            if (existing) existing.errors++;
          }
        }
      }
    }
  }

  let durationMs: number | undefined;
  if (messages.length >= 2) {
    const first = messages[0]!.timestamp.getTime();
    const last = messages[messages.length - 1]!.timestamp.getTime();
    if (last > first) durationMs = last - first;
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  return {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    toolFrequency,
    filesModified: [],
    durationMs,
  };
}

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseZedSession(filePath: string): Promise<NormalizedSession> {
  const now = new Date();
  const emptySession = (id: string): NormalizedSession => ({
    id,
    source: 'zed',
    filePath,
    metadata: {
      cwd: '',
      createdAt: now,
      updatedAt: now,
      fileBytes: 0,
      rawLineCount: 0,
    },
    messages: [],
    stats: {
      totalMessages: 0,
      byRole: { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
      byBlockType: {},
      toolFrequency: [],
      filesModified: [],
    },
  });

  if (!isSqliteAvailable()) {
    return emptySession('no-sqlite');
  }

  // Parse the synthetic filePath: <dbPath>::<threadId>
  let dbPath: string;
  let threadId: string | null = null;

  if (filePath.includes(THREAD_SEP)) {
    const sepIdx = filePath.indexOf(THREAD_SEP);
    dbPath = filePath.substring(0, sepIdx);
    threadId = filePath.substring(sepIdx + THREAD_SEP.length);
  } else {
    dbPath = filePath;
  }

  if (!fs.existsSync(dbPath)) {
    return emptySession(threadId || 'unknown');
  }

  // Query the specific thread or the first one
  let rows: Array<Record<string, unknown>>;
  if (threadId) {
    rows = queryAll(
      dbPath,
      'SELECT id, summary, updated_at, data, data_type, worktree_branch FROM threads WHERE id = ?',
      [threadId],
    );
  } else {
    rows = queryAll(
      dbPath,
      'SELECT id, summary, updated_at, data, data_type, worktree_branch FROM threads ORDER BY updated_at DESC LIMIT 1',
    );
  }

  if (rows.length === 0) {
    return emptySession(threadId || 'unknown');
  }

  const row = rows[0] as unknown as ThreadRow;
  const data = parseThreadData(row);

  if (!data || !data.messages) {
    return emptySession(row.id);
  }

  const model = data.model?.model || undefined;
  const updatedAt = row.updated_at ? new Date(row.updated_at) : now;

  // Build exploded messages
  const exploded: ExplodedMessage[] = [];
  for (let i = 0; i < data.messages.length; i++) {
    const msg = data.messages[i]!;

    if (msg.User) {
      exploded.push(...extractZedContent(msg.User.content, i, updatedAt, 'user'));
    } else if (msg.Agent) {
      exploded.push(...extractZedContent(msg.Agent.content, i, updatedAt, 'assistant'));
    }
  }

  // Assign 1-based indexes
  const messages: NormalizedMessage[] = exploded.map((e, i) => ({
    index: i + 1,
    role: e.role,
    timestamp: e.timestamp,
    content: e.content,
    blocks: e.blocks,
    rawLineIndex: e.rawLineIndex,
  }));

  const metadata: SessionMetadata = {
    cwd: '',
    gitBranch: row.worktree_branch || undefined,
    model,
    createdAt: updatedAt,
    updatedAt,
    fileBytes: row.data ? Buffer.from(row.data).length : 0,
    rawLineCount: data.messages.length,
  };

  const stats = computeStats(messages);

  return {
    id: row.id,
    source: 'zed',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ──────────────────────────────────────────────────────

export async function findZedSessions(): Promise<SessionListEntry[]> {
  if (!isSqliteAvailable()) return [];

  const dbPath = findZedDb();
  if (!dbPath) return [];

  const rows = queryAll(
    dbPath,
    'SELECT id, summary, updated_at, data_type, worktree_branch FROM threads ORDER BY updated_at DESC',
  );

  const entries: SessionListEntry[] = [];

  for (const row of rows) {
    const id = row.id as string;
    const summary = (row.summary as string) || undefined;
    const updatedAt = row.updated_at ? new Date(row.updated_at as string) : new Date(0);
    const syntheticPath = `${dbPath}${THREAD_SEP}${id}`;

    entries.push({
      id,
      source: 'zed',
      cwd: '',
      updatedAt,
      summary: summary ? truncate(summary, 120) : undefined,
      filePath: syntheticPath,
    });
  }

  return entries;
}

// ── Registry ───────────────────────────────────────────────────────────────

registerSource({
  name: 'zed',
  label: 'Zed',
  color: '#0078FF',
  find: findZedSessions,
  parse: parseZedSession,
});
