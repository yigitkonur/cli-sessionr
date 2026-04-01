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
import { readJsonFile, truncate } from './common.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['default', 'dev_data', 'index', 'sessions', 'workspace-sessions']);

// ── Platform paths ─────────────────────────────────────────────────────────

function getKiroAgentDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  switch (process.platform) {
    case 'darwin':
      dirs.push(path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'));
      break;
    case 'win32':
      dirs.push(path.join(home, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'));
      break;
    default: // linux
      dirs.push(path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'));
      break;
  }

  // Fallback path for all platforms
  dirs.push(path.join(home, '.kiro', 'User', 'globalStorage', 'kiro.kiroagent'));

  return dirs;
}

function findKiroAgentDir(): string | null {
  for (const dir of getKiroAgentDirs()) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// ── Raw data shapes ────────────────────────────────────────────────────────

interface WorkspaceSessionIndex {
  sessionId: string;
  title?: string;
  dateCreated?: string;
  workspaceDirectory?: string;
}

interface WorkspaceSessionContent {
  type: 'text' | 'mention';
  text: string;
}

interface WorkspaceSessionMessage {
  role: 'user' | 'assistant';
  content: WorkspaceSessionContent[];
}

interface WorkspaceSessionEntry {
  message: WorkspaceSessionMessage;
  promptLogs?: Array<{ modelTitle?: string }>;
}

interface WorkspaceSessionData {
  history?: WorkspaceSessionEntry[];
}

interface ChatFileMetadata {
  startTime?: number;
  endTime?: number;
  workflow?: string;
  modelId?: string;
}

interface ChatFileMessage {
  role: 'human' | 'bot' | 'tool';
  content: string;
}

interface ChatFileContext {
  type?: string;
  id?: string;
}

interface ChatFileData {
  executionId?: string;
  metadata?: ChatFileMetadata;
  chat?: ChatFileMessage[];
  context?: ChatFileContext[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const clean = title
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/## Included Rules[\s\S]*$/m, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || null;
}

function isSystemPrompt(content: string): boolean {
  return content.startsWith('<identity>') || content.startsWith('# ');
}

function extractUserRequest(content: string): string | null {
  const ruleEnd = content.lastIndexOf('</user-rule>');
  if (ruleEnd >= 0) {
    let userPart = content.substring(ruleEnd + '</user-rule>'.length).trim();
    const envIdx = userPart.indexOf('<EnvironmentContext>');
    if (envIdx >= 0) userPart = userPart.substring(0, envIdx).trim();
    const steerIdx = userPart.indexOf('<steering-reminder>');
    if (steerIdx >= 0) userPart = userPart.substring(0, steerIdx).trim();
    if (userPart) return userPart;
  }
  return null;
}

function extractContentFromMessage(content: WorkspaceSessionContent[] | string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' || c.type === 'mention')
    .map((c) => c.text)
    .join('\n') || '';
}

function getFileMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtime.getTime();
  } catch {
    return null;
  }
}

// ── Workspace session parsing ──────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
  model?: string;
}

function parseWorkspaceSessionMessages(data: WorkspaceSessionData): ExplodedMessage[] {
  const messages: ExplodedMessage[] = [];
  const history = data.history || [];

  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!;
    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;

    const content = extractContentFromMessage(msg.content);
    if (!content) continue;

    const result: ExplodedMessage = {
      role: role as 'user' | 'assistant',
      content,
      blocks: [{ type: 'text', text: content }],
      timestamp: new Date(),
      rawLineIndex: i,
    };

    // Extract model from promptLogs
    if (role === 'assistant' && entry.promptLogs && entry.promptLogs.length > 0) {
      const log = entry.promptLogs[0];
      if (log?.modelTitle) result.model = log.modelTitle;
    }

    messages.push(result);
  }

  return messages;
}

// ── Chat file parsing ──────────────────────────────────────────────────────

function parseChatFileMessages(data: ChatFileData): ExplodedMessage[] {
  const messages: ExplodedMessage[] = [];
  const chat = data.chat || [];
  const model = data.metadata?.modelId || undefined;
  const startTime = data.metadata?.startTime ? new Date(data.metadata.startTime) : new Date();

  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i]!;

    if (msg.role === 'human') {
      if (isSystemPrompt(msg.content)) continue;

      // Try extracting user request from rules block first
      const userReq = extractUserRequest(msg.content);
      const content = userReq || (isSystemPrompt(msg.content) ? null : cleanTitle(msg.content));
      if (!content) continue;

      messages.push({
        role: 'user',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: startTime,
        rawLineIndex: i,
      });
    } else if (msg.role === 'bot') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!content) continue;

      messages.push({
        role: 'assistant',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: startTime,
        rawLineIndex: i,
        model,
      });
    } else if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content.substring(0, 2000) : '';
      if (!content) continue;

      messages.push({
        role: 'tool_result',
        content,
        blocks: [{
          type: 'tool_result',
          toolUseId: `kiro-tool-${i}`,
          content,
          isError: false,
        }],
        timestamp: startTime,
        rawLineIndex: i,
      });
    }
  }

  return messages;
}

// ── Detect file type ────────────────────────────────────────────────────────

function detectFileType(filePath: string): 'workspace-session' | 'chat-file' | null {
  if (filePath.endsWith('.chat')) return 'chat-file';

  // Check if this is inside workspace-sessions directory
  if (filePath.includes('workspace-sessions')) return 'workspace-session';

  // Try reading to detect
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.history) return 'workspace-session';
    if (data.chat) return 'chat-file';
  } catch {
    // fall through
  }

  return null;
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

export async function parseKiroSession(filePath: string): Promise<NormalizedSession> {
  const now = new Date();
  const emptySession = (id: string): NormalizedSession => ({
    id,
    source: 'kiro',
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
  });

  const fileType = detectFileType(filePath);
  if (!fileType) return emptySession(path.basename(filePath, '.json'));

  let fileBytes = 0;
  try {
    fileBytes = fs.statSync(filePath).size;
  } catch {
    // ignore
  }

  let rawData: unknown;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    rawData = JSON.parse(raw);
  } catch {
    return emptySession(path.basename(filePath, '.json'));
  }

  let exploded: ExplodedMessage[];
  let sessionId: string;
  let cwd = path.dirname(filePath);
  let model: string | undefined;
  let createdAt = now;
  let updatedAt = now;

  if (fileType === 'workspace-session') {
    const data = rawData as WorkspaceSessionData;
    exploded = parseWorkspaceSessionMessages(data);
    sessionId = path.basename(filePath, '.json');

    // Try to decode workspace path from parent directory name
    const parentDir = path.basename(path.dirname(filePath));
    try {
      const decoded = Buffer.from(parentDir, 'base64').toString('utf-8');
      if (decoded && decoded.startsWith('/')) cwd = decoded;
    } catch {
      // not a base64-encoded path
    }

    // Extract model from first assistant message with model info
    for (const msg of exploded) {
      if (msg.model) { model = msg.model; break; }
    }
  } else {
    // chat-file
    const data = rawData as ChatFileData;
    exploded = parseChatFileMessages(data);
    sessionId = data.executionId || path.basename(filePath, '.chat');

    if (data.metadata?.startTime) createdAt = new Date(data.metadata.startTime);
    if (data.metadata?.endTime) updatedAt = new Date(data.metadata.endTime);
    if (data.metadata?.modelId) model = data.metadata.modelId;

    // Try to extract folder from context
    for (const ctx of data.context || []) {
      if (ctx.type === 'steering' && ctx.id) {
        const match = ctx.id.match(/file:\/\/(.*?)\/.kiro\//);
        if (match) { cwd = match[1]!; break; }
      }
    }

    // Extract model from exploded messages as fallback
    if (!model) {
      for (const msg of exploded) {
        if (msg.model) { model = msg.model; break; }
      }
    }
  }

  // Assign timestamps from session metadata to all messages
  for (const msg of exploded) {
    if (msg.timestamp.getTime() === now.getTime()) {
      msg.timestamp = createdAt;
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
    cwd,
    model,
    createdAt,
    updatedAt,
    fileBytes,
    rawLineCount: exploded.length,
  };

  const stats = computeStats(messages);

  return {
    id: sessionId,
    source: 'kiro',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ──────────────────────────────────────────────────────

interface ChatMeta {
  title: string | null;
  folder: string | null;
  startTime: number | null;
  endTime: number | null;
  workflow: string | null;
  messageCount: number;
  executionId: string | null;
}

function peekChatMeta(filePath: string): ChatMeta {
  const meta: ChatMeta = {
    title: null,
    folder: null,
    startTime: null,
    endTime: null,
    workflow: null,
    messageCount: 0,
    executionId: null,
  };

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as ChatFileData;

    meta.executionId = data.executionId || null;

    if (data.metadata) {
      meta.startTime = data.metadata.startTime || null;
      meta.endTime = data.metadata.endTime || null;
      meta.workflow = data.metadata.workflow || null;
    }

    const chat = data.chat || [];
    for (const msg of chat) {
      if (msg.role === 'human') {
        const userReq = extractUserRequest(msg.content);
        if (userReq && !meta.title) {
          meta.title = cleanTitle(userReq);
        }
      }
      if (msg.role === 'bot' || msg.role === 'human') meta.messageCount++;
    }

    // Try to extract folder from context
    for (const ctx of data.context || []) {
      if (ctx.type === 'steering' && ctx.id) {
        const match = ctx.id.match(/file:\/\/(.*?)\/.kiro\//);
        if (match) meta.folder = match[1]!;
      }
    }
  } catch {
    // skip malformed files
  }

  return meta;
}

export async function findKiroSessions(): Promise<SessionListEntry[]> {
  const kiroDir = findKiroAgentDir();
  if (!kiroDir) return [];

  const entries: SessionListEntry[] = [];
  const wsSessionsDir = path.join(kiroDir, 'workspace-sessions');

  // ── Strategy 1: workspace-sessions ─────────────────────────────────────
  if (fs.existsSync(wsSessionsDir)) {
    try {
      for (const folder of fs.readdirSync(wsSessionsDir)) {
        const wsDir = path.join(wsSessionsDir, folder);
        try {
          if (!fs.statSync(wsDir).isDirectory()) continue;
        } catch { continue; }

        // Decode base64 folder name to get workspace path
        let workspacePath: string | null = null;
        try {
          workspacePath = Buffer.from(folder, 'base64').toString('utf-8');
        } catch {
          // not base64
        }

        const indexPath = path.join(wsDir, 'sessions.json');
        let sessions: WorkspaceSessionIndex[] = [];
        try {
          sessions = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        } catch { continue; }

        for (const session of sessions) {
          const sessionFile = path.join(wsDir, `${session.sessionId}.json`);
          const exists = fs.existsSync(sessionFile);
          const mtime = exists ? getFileMtime(sessionFile) : null;

          const createdAt = parseInt(session.dateCreated || '') || null;
          const updatedAt = mtime || createdAt || Date.now();

          entries.push({
            id: session.sessionId,
            source: 'kiro',
            cwd: session.workspaceDirectory || workspacePath || wsDir,
            updatedAt: new Date(updatedAt),
            summary: cleanTitle(session.title) ?? undefined,
            filePath: exists ? sessionFile : indexPath,
          });
        }
      }
    } catch {
      // skip
    }
  }

  // ── Strategy 2: .chat files in hash directories ────────────────────────
  const seenIds = new Set(entries.map((e) => e.id));
  const executionMap = new Map<string, SessionListEntry & { _messageCount: number }>();

  try {
    for (const dir of fs.readdirSync(kiroDir)) {
      if (SKIP_DIRS.has(dir)) continue;
      const fullDir = path.join(kiroDir, dir);
      try {
        if (!fs.statSync(fullDir).isDirectory()) continue;
      } catch { continue; }

      let files: string[];
      try {
        files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.chat'));
      } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(fullDir, file);
        try {
          const stat = fs.statSync(fullPath);
          const meta = peekChatMeta(fullPath);
          const chatId = meta.executionId || `${dir}/${file.replace('.chat', '')}`;
          if (seenIds.has(chatId)) continue;

          const candidate = {
            id: chatId,
            source: 'kiro' as const,
            cwd: meta.folder || '',
            updatedAt: new Date(meta.endTime || stat.mtime.getTime()),
            summary: meta.title ?? undefined,
            filePath: fullPath,
            _messageCount: meta.messageCount,
          };

          // Keep the snapshot with the most messages per executionId
          if (meta.executionId) {
            const existing = executionMap.get(meta.executionId);
            if (!existing || meta.messageCount > existing._messageCount) {
              // Preserve earliest createdAt
              if (existing && existing.updatedAt < candidate.updatedAt) {
                // keep the new candidate's updatedAt
              }
              executionMap.set(meta.executionId, candidate);
            }
          } else {
            entries.push(candidate);
          }
        } catch {
          // skip malformed files
        }
      }
    }
  } catch {
    // skip
  }

  // Add deduplicated execution sessions
  for (const chat of Array.from(executionMap.values())) {
    entries.push(chat);
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ───────────────────────────────────────────────────────────────

registerSource({
  name: 'kiro',
  label: 'Kiro',
  color: '#FF9900',
  find: findKiroSessions,
  parse: parseKiroSession,
});
