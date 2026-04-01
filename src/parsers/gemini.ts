import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedSession,
  SessionListEntry,
  SessionMetadata,
  SessionStats,
} from '../types.js';
import { readJsonFile, getFileStats, truncate } from './common.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');

// ── Raw JSON types ──────────────────────────────────────────────────────────

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
}

interface GeminiThought {
  description?: string;
  subject?: string;
}

interface GeminiToolCallResult {
  functionResponse?: {
    id?: string;
    name?: string;
    response?: { error?: string; output?: string };
  };
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: GeminiToolCallResult[];
  status?: string;
}

interface GeminiMessage {
  type?: string;
  content?: string | Array<{ text?: string }>;
  displayContent?: string | Array<{ text?: string }>;
  thoughts?: GeminiThought[];
  toolCalls?: GeminiToolCall[];
  tokens?: GeminiTokens;
  model?: string;
}

interface GeminiSession {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: { text?: string }) => p.text)
      .map((p: { text?: string }) => p.text!)
      .join('\n') || '';
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    return (content as { text: string }).text || '';
  }
  return '';
}

function cleanPrompt(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

/**
 * Load project path mapping from ~/.gemini/projects.json
 * Format: { "projects": { "/Users/dev/Code/myapp": "myapp" } }
 * Returns Map<projectName, folderPath>
 */
function loadProjectMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(PROJECTS_JSON, 'utf-8');
    const data = JSON.parse(raw) as { projects?: Record<string, string> };
    if (data.projects) {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        map.set(projName, folderPath);
      }
    }
  } catch {
    // Missing or malformed projects.json
  }
  return map;
}

// ── Message explosion ───────────────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function explodeGeminiMessage(
  msg: GeminiMessage,
  msgIndex: number,
  timestamp: Date,
): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const type = msg.type;
  const text = extractTextContent(msg.content || msg.displayContent);

  if (type === 'user') {
    if (text) {
      results.push({
        role: 'user',
        content: text,
        blocks: [{ type: 'text', text }],
        timestamp,
        rawLineIndex: msgIndex,
      });
    }
    return results;
  }

  if (type === 'gemini') {
    // Collect thinking blocks first
    const thinkingBlocks: ContentBlock[] = [];
    if (msg.thoughts && Array.isArray(msg.thoughts)) {
      for (const t of msg.thoughts) {
        const thought = t.description || t.subject || '';
        if (thought) {
          thinkingBlocks.push({ type: 'thinking', text: thought });
        }
      }
    }

    // Build assistant message with text + thinking blocks
    const assistantBlocks: ContentBlock[] = [...thinkingBlocks];
    let assistantContent = '';

    if (text) {
      assistantBlocks.push({ type: 'text', text });
      assistantContent = text;
    }

    // Flush the assistant message (thinking + text) before tool calls
    if (assistantBlocks.length > 0) {
      results.push({
        role: 'assistant',
        content: assistantContent,
        blocks: [...assistantBlocks],
        timestamp,
        rawLineIndex: msgIndex,
      });
    }

    // Explode tool calls as separate tool_use + tool_result messages
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const toolName = tc.name || 'unknown';
        const args = tc.args || {};
        const callId = tc.id || `gemini-tool-${msgIndex}-${toolName}`;
        const toolBlock: ContentBlock = {
          type: 'tool_use',
          id: callId,
          name: toolName,
          input: args,
        };
        results.push({
          role: 'tool_use',
          content: `Tool: ${toolName}`,
          blocks: [toolBlock],
          timestamp,
          rawLineIndex: msgIndex,
        });

        // Extract tool result from embedded result array
        if (tc.result && Array.isArray(tc.result)) {
          for (const res of tc.result) {
            const fr = res.functionResponse;
            if (!fr) continue;
            const resp = fr.response || {};
            const isError = tc.status === 'error' || !!resp.error;
            const content = resp.error || resp.output || '';
            const resultBlock: ContentBlock = {
              type: 'tool_result',
              toolUseId: callId,
              content,
              isError,
            };
            results.push({
              role: 'tool_result',
              content,
              blocks: [resultBlock],
              timestamp,
              rawLineIndex: msgIndex,
            });
          }
        }
      }
    }

    return results;
  }

  if (type === 'info' || type === 'error' || type === 'warning') {
    if (text) {
      results.push({
        role: 'system',
        content: `[${type}] ${text}`,
        blocks: [{ type: 'text', text: `[${type}] ${text}` }],
        timestamp,
        rawLineIndex: msgIndex,
      });
    }
    return results;
  }

  return results;
}

// ── Stats computation ───────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  rawMessages: GeminiMessage[],
): SessionStats {
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; errors: number }>();

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        byRole.user++;
        break;
      case 'assistant':
        byRole.assistant++;
        break;
      case 'system':
        byRole.system++;
        break;
      case 'tool_use':
        byRole.toolUse++;
        break;
      case 'tool_result':
        byRole.toolResult++;
        break;
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

  // Token usage from raw gemini messages
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;

  for (const msg of rawMessages) {
    if (msg.type === 'gemini' && msg.tokens) {
      const t = msg.tokens;
      if (t.input) {
        inputTokens += t.input;
        hasTokens = true;
      }
      if (t.output) {
        outputTokens += t.output;
        hasTokens = true;
      }
      if (t.cached) {
        cacheRead += t.cached;
      }
    }
  }

  // Duration: passed in from session-level timestamps (more reliable than per-message)
  let durationMs: number | undefined;

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  return {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    tokenUsage: hasTokens
      ? {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheRead || undefined,
        }
      : undefined,
    toolFrequency,
    filesModified: [],
    durationMs,
  };
}

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseGeminiSession(filePath: string): Promise<NormalizedSession> {
  const record = await readJsonFile<GeminiSession>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  if (!record || !record.messages) {
    const now = new Date();
    return {
      id: path.basename(filePath, '.json'),
      source: 'gemini',
      filePath,
      metadata: {
        cwd: path.dirname(filePath),
        createdAt: now,
        updatedAt: now,
        fileBytes,
        rawLineCount,
      },
      messages: [],
      stats: {
        totalMessages: 0,
        byRole: { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
        byBlockType: {},
        toolFrequency: [],
        filesModified: [],
      },
    };
  }

  const rawMessages = record.messages;

  // Extract model from the last gemini message that has one
  let model: string | undefined;
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    if (rawMessages[i]!.model) {
      model = rawMessages[i]!.model;
      break;
    }
  }

  // Timestamps
  const createdAt = record.startTime ? new Date(record.startTime) : new Date();
  const updatedAt = record.lastUpdated ? new Date(record.lastUpdated) : createdAt;

  // Session ID
  const sessionId = record.sessionId || path.basename(filePath, '.json');

  // Explode messages
  const exploded: ExplodedMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i]!;
    // Use session start time as base, offset by message index for ordering
    const msgTs = record.startTime ? new Date(new Date(record.startTime).getTime() + i) : new Date();
    exploded.push(...explodeGeminiMessage(msg, i, msgTs));
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

  // Resolve CWD from project map instead of file path
  const projectMap = loadProjectMap();
  // filePath like ~/.gemini/tmp/<projName>/chats/session-xxx.json
  const chatsDir = path.dirname(filePath);
  const projDir = path.dirname(chatsDir);
  const projName = path.basename(projDir);
  const cwd = projectMap.get(projName) || projDir;

  const metadata: SessionMetadata = {
    cwd,
    model,
    createdAt,
    updatedAt,
    fileBytes,
    rawLineCount,
  };

  const stats = computeStats(messages, rawMessages);

  // Use session-level timestamps for duration (per-message timestamps are synthetic)
  if (createdAt && updatedAt) {
    const diff = updatedAt.getTime() - createdAt.getTime();
    if (diff > 0) stats.durationMs = diff;
  }

  return {
    id: sessionId,
    source: 'gemini',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ───────────────────────────────────────────────────────

export async function findGeminiSessions(): Promise<SessionListEntry[]> {
  if (!fs.existsSync(TMP_DIR)) return [];

  const projectMap = loadProjectMap();
  const entries: SessionListEntry[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(TMP_DIR);
  } catch {
    return [];
  }

  for (const projName of projectDirs) {
    const projDir = path.join(TMP_DIR, projName);
    try {
      if (!fs.statSync(projDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const chatsDir = path.join(projDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(chatsDir).filter(
        (f) => f.startsWith('session-') && f.endsWith('.json'),
      );
    } catch {
      continue;
    }

    // Resolve folder from projects.json mapping
    const folder = projectMap.get(projName) || projDir;

    for (const file of files) {
      const fullPath = path.join(chatsDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const record = JSON.parse(raw) as GeminiSession;
        if (!record || !record.messages) continue;

        const sessionId = record.sessionId || file.replace('.json', '');
        const messages = record.messages || [];

        // Extract first user prompt for summary
        const firstUser = messages.find((m) => m.type === 'user');
        const firstPrompt = extractTextContent(firstUser?.content);

        const updatedAt = record.lastUpdated
          ? new Date(record.lastUpdated)
          : record.startTime
            ? new Date(record.startTime)
            : new Date(0);

        entries.push({
          id: sessionId,
          source: 'gemini',
          cwd: folder,
          updatedAt,
          summary: cleanPrompt(firstPrompt) ?? undefined,
          filePath: fullPath,
        });
      } catch {
        // Skip malformed files
      }
    }
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'gemini',
  label: 'Gemini CLI',
  color: '#4285F4',
  find: findGeminiSessions,
  parse: parseGeminiSession,
});
