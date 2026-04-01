import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import type {
  NormalizedSession,
  NormalizedMessage,
  ContentBlock,
  SessionMetadata,
  SessionStats,
  SessionListEntry,
} from '../types.js';

import { readJsonFile, findFiles, truncate } from './common.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const STORAGE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
const SESSION_DIR = path.join(STORAGE_DIR, 'session');
const MESSAGE_DIR = path.join(STORAGE_DIR, 'message');
const PART_DIR = path.join(STORAGE_DIR, 'part');

// ── Raw file shapes ─────────────────────────────────────────────────────────

interface SessionManifest {
  id: string;
  title?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
  modelID?: string;
  providerID?: string;
}

interface MessageFile {
  id: string;
  sessionID?: string;
  role?: 'user' | 'assistant' | string;
  time?: { created?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  modelID?: string;
}

interface PartFile {
  id: string;
  messageID?: string;
  type?: string;
  text?: string;
  content?: string;
  name?: string;
  toolName?: string;
  tool?: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  output?: string;
  state?: { input?: unknown; output?: string };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parsePartToBlocks(part: PartFile): ContentBlock | null {
  const type = part.type;
  if (!type) return null;

  // text -> text ContentBlock
  if (type === 'text') {
    const text = part.text || part.content || '';
    if (!text.trim()) return null;
    return { type: 'text', text };
  }

  // thinking / reasoning -> thinking ContentBlock
  if (type === 'thinking' || type === 'reasoning') {
    const text = part.text || part.content || '';
    if (!text.trim()) return null;
    return { type: 'thinking', text };
  }

  // tool-call / tool_use / tool -> tool_use ContentBlock
  if (type === 'tool-call' || type === 'tool_use' || type === 'tool') {
    const name = part.name || part.toolName || part.tool || part.content || 'tool';
    let input: Record<string, unknown> = {};

    const rawInput = part.input ?? part.args ?? part.arguments ?? part.state?.input;
    if (rawInput != null) {
      if (typeof rawInput === 'string') {
        try {
          input = JSON.parse(rawInput) as Record<string, unknown>;
        } catch {
          input = { raw: rawInput };
        }
      } else if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
        input = rawInput as Record<string, unknown>;
      }
    }

    return { type: 'tool_use', id: part.id || '', name, input };
  }

  // tool-result / tool_result -> tool_result ContentBlock
  if (type === 'tool-result' || type === 'tool_result') {
    const content =
      part.text || part.output || part.content || part.state?.output || '';
    return {
      type: 'tool_result',
      toolUseId: part.messageID || '',
      content: typeof content === 'string' ? content.substring(0, 500) : String(content),
      isError: false,
    };
  }

  return null;
}

// ── Explode blocks into messages ────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function explodeBlocks(
  role: string,
  blocks: ContentBlock[],
  timestamp: Date,
  lineIndex: number,
): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const textBlocks: ContentBlock[] = [];
  let textContent = '';

  const mappedRole: NormalizedMessage['role'] =
    role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        textBlocks.push(block);
        textContent += (textContent ? '\n' : '') + block.text;
        break;
      }

      case 'thinking': {
        textBlocks.push(block);
        break;
      }

      case 'tool_use': {
        // Flush accumulated text before tool_use
        if (textBlocks.length > 0) {
          results.push({
            role: mappedRole,
            content: textContent,
            blocks: [...textBlocks],
            timestamp,
            rawLineIndex: lineIndex,
          });
          textBlocks.length = 0;
          textContent = '';
        }
        results.push({
          role: 'tool_use',
          content: `Tool: ${block.name}`,
          blocks: [block],
          timestamp,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'tool_result': {
        // Flush accumulated text before tool_result
        if (textBlocks.length > 0) {
          results.push({
            role: mappedRole,
            content: textContent,
            blocks: [...textBlocks],
            timestamp,
            rawLineIndex: lineIndex,
          });
          textBlocks.length = 0;
          textContent = '';
        }
        results.push({
          role: 'tool_result',
          content: block.content,
          blocks: [block],
          timestamp,
          rawLineIndex: lineIndex,
        });
        break;
      }
    }
  }

  // Flush remaining text
  if (textBlocks.length > 0) {
    results.push({
      role: mappedRole,
      content: textContent,
      blocks: [...textBlocks],
      timestamp,
      rawLineIndex: lineIndex,
    });
  }

  return results;
}

// ── Compute stats ───────────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  totalInput: number,
  totalOutput: number,
  totalCacheRead: number,
  totalCacheWrite: number,
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
      byBlockType[block.type] = (byBlockType[block.type] ?? 0) + 1;
      if (block.type === 'tool_use') {
        const existing = toolCounts.get(block.name) ?? { count: 0, errors: 0 };
        existing.count++;
        toolCounts.set(block.name, existing);
      }
      if (block.type === 'tool_result' && block.isError) {
        // Try to attribute error to the most recent tool_use
        // (simple heuristic since Goose toolResult doesn't carry toolUseId reliably)
      }
    }
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  const hasTokens = totalInput > 0 || totalOutput > 0;

  let durationMs: number | undefined;
  if (messages.length >= 2) {
    const first = messages[0]!.timestamp.getTime();
    const last = messages[messages.length - 1]!.timestamp.getTime();
    if (last > first) durationMs = last - first;
  }

  return {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    tokenUsage: hasTokens
      ? {
          input: totalInput,
          output: totalOutput,
          ...(totalCacheRead > 0 ? { cacheRead: totalCacheRead } : {}),
          ...(totalCacheWrite > 0 ? { cacheCreation: totalCacheWrite } : {}),
        }
      : undefined,
    toolFrequency,
    filesModified: [],
    durationMs,
  };
}

// ── parseOpenCodeSession ────────────────────────────────────────────────────

export async function parseOpenCodeSession(filePath: string): Promise<NormalizedSession> {
  // filePath points to a ses_<id>.json session manifest
  const session = await readJsonFile<SessionManifest>(filePath);
  if (!session || !session.id) {
    // Return empty session if manifest is invalid
    const now = new Date();
    return {
      id: path.basename(filePath, '.json'),
      source: 'opencode',
      filePath,
      metadata: {
        cwd: path.dirname(filePath),
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
    };
  }

  const sessionId = session.id;
  const model = session.modelID;
  const cwd = session.directory || '';
  const createdAt = session.time?.created ? new Date(session.time.created) : new Date();
  let updatedAt = session.time?.updated ? new Date(session.time.updated) : createdAt;

  // Read messages for this session
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  const msgFiles = findFiles(sessionMsgDir, (name) => name.startsWith('msg_') && name.endsWith('.json'), 1);

  // Read and sort messages by creation time
  const rawMsgs: MessageFile[] = [];
  for (const msgPath of msgFiles) {
    const msg = await readJsonFile<MessageFile>(msgPath);
    if (msg && msg.id) rawMsgs.push(msg);
  }
  rawMsgs.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

  // Accumulate tokens and build exploded messages
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  const allExploded: ExplodedMessage[] = [];

  for (let msgIdx = 0; msgIdx < rawMsgs.length; msgIdx++) {
    const msg = rawMsgs[msgIdx];
    const role = msg.role || 'assistant';
    const msgTimestamp = msg.time?.created ? new Date(msg.time.created) : createdAt;

    // Accumulate tokens
    if (msg.tokens) {
      totalInput += msg.tokens.input ?? 0;
      totalOutput += msg.tokens.output ?? 0;
      totalCacheRead += msg.tokens.cache?.read ?? 0;
      totalCacheWrite += msg.tokens.cache?.write ?? 0;
    }

    // Read parts for this message
    const msgPartDir = path.join(PART_DIR, msg.id);
    const partFiles = findFiles(msgPartDir, (name) => name.startsWith('prt_') && name.endsWith('.json'), 1);

    const parts: PartFile[] = [];
    for (const partPath of partFiles) {
      const part = await readJsonFile<PartFile>(partPath);
      if (part) parts.push(part);
    }

    // Convert parts to content blocks
    const blocks: ContentBlock[] = [];
    for (const part of parts) {
      const block = parsePartToBlocks(part);
      if (block) blocks.push(block);
    }

    // If no parts produced content, create a minimal placeholder
    if (blocks.length === 0) {
      continue; // skip messages with no meaningful content
    }

    // Explode blocks into separate messages per the pattern
    allExploded.push(...explodeBlocks(role, blocks, msgTimestamp, msgIdx));
  }

  // Assign 1-based indexes
  const messages: NormalizedMessage[] = allExploded.map((e, i) => ({
    index: i + 1,
    role: e.role,
    timestamp: e.timestamp,
    content: e.content,
    blocks: e.blocks,
    rawLineIndex: e.rawLineIndex,
  }));

  // Update updatedAt from messages
  if (messages.length > 0) {
    const lastTs = messages[messages.length - 1]!.timestamp;
    if (lastTs.getTime() > updatedAt.getTime()) updatedAt = lastTs;
  }

  const metadata: SessionMetadata = {
    cwd: cwd || path.dirname(filePath),
    model,
    createdAt,
    updatedAt,
    fileBytes: 0,
    rawLineCount: rawMsgs.length,
  };

  const stats = computeStats(messages, totalInput, totalOutput, totalCacheRead, totalCacheWrite);

  return {
    id: sessionId,
    source: 'opencode',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── findOpenCodeSessions ────────────────────────────────────────────────────

export async function findOpenCodeSessions(): Promise<SessionListEntry[]> {
  const entries: SessionListEntry[] = [];

  if (!fs.existsSync(SESSION_DIR)) return entries;

  // Iterate project hash directories
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;

    const projectDir = path.join(SESSION_DIR, dirent.name);
    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter(
        (f) => f.startsWith('ses_') && f.endsWith('.json'),
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const data = await readJsonFile<SessionManifest>(filePath);
      if (!data || !data.id) continue;

      // Clean title
      let summary: string | undefined;
      if (data.title) {
        const cleaned = data.title.startsWith('New session - ') ? undefined : data.title;
        summary = cleaned ? truncate(cleaned.trim(), 120) || undefined : undefined;
      }

      entries.push({
        id: data.id,
        source: 'opencode',
        cwd: data.directory || '',
        updatedAt: data.time?.updated ? new Date(data.time.updated) : new Date(0),
        summary,
        filePath,
      });
    }
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'opencode',
  label: 'OpenCode',
  color: '#00B4D8',
  find: findOpenCodeSessions,
  parse: parseOpenCodeSession,
});
