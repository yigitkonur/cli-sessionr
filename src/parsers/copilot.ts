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
import { readJsonlFile, getFileStats } from './common.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');

// ── Raw event types ─────────────────────────────────────────────────────────

interface CopilotToolRequest {
  name?: string;
  toolName?: string;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
}

interface CopilotModelMetrics {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
}

interface CopilotEventData {
  cwd?: string;
  currentModel?: string;
  content?: string;
  toolRequests?: CopilotToolRequest[];
  modelMetrics?: Record<string, CopilotModelMetrics>;
}

interface CopilotEvent {
  type: string;
  timestamp?: string;
  data?: CopilotEventData;
}

// ── workspace.yaml parsing (regex-based, no yaml library) ───────────────────

interface WorkspaceMeta {
  id?: string;
  cwd?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  branch?: string;
}

function parseWorkspaceYaml(sessionDir: string): WorkspaceMeta | null {
  const yamlPath = path.join(sessionDir, 'workspace.yaml');
  if (!fs.existsSync(yamlPath)) return null;

  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const meta: Record<string, string> = {};
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\w+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1]!;
      const val = match[2]!.trim();
      // Handle YAML block scalars (|, |-, >-, etc.)
      if (/^[|>][-+]?$/.test(val)) {
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^\s+/)) {
            blockLines.push(lines[j].replace(/^\s+/, ''));
          } else {
            break;
          }
        }
        meta[key] = blockLines.join(' ').trim();
      } else {
        meta[key] = val;
      }
    }
    return meta as unknown as WorkspaceMeta;
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanPrompt(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function safeParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Message explosion ───────────────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function explodeCopilotEvent(
  event: CopilotEvent,
  eventIndex: number,
): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const ts = event.timestamp ? new Date(event.timestamp) : new Date();
  const data = event.data;

  if (event.type === 'user.message') {
    const content = data?.content;
    if (content) {
      results.push({
        role: 'user',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: ts,
        rawLineIndex: eventIndex,
      });
    }
    return results;
  }

  if (event.type === 'assistant.message') {
    const content = data?.content;

    // Push the assistant text message first
    if (content) {
      results.push({
        role: 'assistant',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: ts,
        rawLineIndex: eventIndex,
      });
    }

    // Explode tool requests as separate tool_use messages
    if (data?.toolRequests && Array.isArray(data.toolRequests)) {
      for (const tr of data.toolRequests) {
        const toolName = tr.name || tr.toolName || 'unknown';
        const rawArgs = tr.args ?? tr.arguments ?? tr.input ?? {};
        const args: Record<string, unknown> =
          typeof rawArgs === 'string' ? safeParse(rawArgs) : (rawArgs as Record<string, unknown>);

        const toolBlock: ContentBlock = {
          type: 'tool_use',
          id: `copilot-tool-${eventIndex}-${toolName}`,
          name: toolName,
          input: args,
        };
        results.push({
          role: 'tool_use',
          content: `Tool: ${toolName}`,
          blocks: [toolBlock],
          timestamp: ts,
          rawLineIndex: eventIndex,
        });
      }
    }

    return results;
  }

  return results;
}

// ── Stats computation ───────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  events: CopilotEvent[],
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

  // Aggregate token usage from session.shutdown modelMetrics
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;

  const shutdown = events.find((e) => e.type === 'session.shutdown');
  if (shutdown?.data?.modelMetrics) {
    for (const metrics of Object.values(shutdown.data.modelMetrics)) {
      const u = metrics.usage;
      if (u) {
        if (u.inputTokens) {
          inputTokens += u.inputTokens;
          hasTokens = true;
        }
        if (u.outputTokens) {
          outputTokens += u.outputTokens;
          hasTokens = true;
        }
        if (u.cacheReadTokens) {
          cacheRead += u.cacheReadTokens;
        }
      }
    }
  }

  // Duration from first to last message timestamp
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

export async function parseCopilotSession(filePath: string): Promise<NormalizedSession> {
  // filePath is the session directory
  const sessionDir = filePath;
  const meta = parseWorkspaceYaml(sessionDir);
  const eventsPath = path.join(sessionDir, 'events.jsonl');

  const events = await readJsonlFile<CopilotEvent>(eventsPath);
  const fileStats = fs.existsSync(eventsPath) ? await getFileStats(eventsPath) : { lines: 0, bytes: 0 };

  // Extract metadata from workspace.yaml + events
  const sessionId = meta?.id || path.basename(sessionDir);
  const cwd = meta?.cwd || '';
  const gitBranch = meta?.branch;

  // Model from session.start or session.shutdown events
  let model: string | undefined;
  const startEvent = events.find((e) => e.type === 'session.start');
  const shutdownEvent = events.find((e) => e.type === 'session.shutdown');
  model = startEvent?.data?.currentModel || shutdownEvent?.data?.currentModel || undefined;

  // Use cwd from session.start event if not in workspace.yaml
  const effectiveCwd = cwd || startEvent?.data?.cwd || sessionDir;

  // Timestamps
  const createdAt = meta?.created_at ? new Date(meta.created_at) : new Date();
  const updatedAt = meta?.updated_at ? new Date(meta.updated_at) : createdAt;

  // Explode events into messages
  const exploded: ExplodedMessage[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    exploded.push(...explodeCopilotEvent(event, i));
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
    cwd: effectiveCwd,
    gitBranch,
    model,
    createdAt,
    updatedAt,
    fileBytes: fileStats.bytes,
    rawLineCount: fileStats.lines,
  };

  const stats = computeStats(messages, events);

  return {
    id: sessionId,
    source: 'copilot',
    filePath: sessionDir,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ───────────────────────────────────────────────────────

export async function findCopilotSessions(): Promise<SessionListEntry[]> {
  if (!fs.existsSync(SESSION_STATE_DIR)) return [];

  const entries: SessionListEntry[] = [];

  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(SESSION_STATE_DIR);
  } catch {
    return [];
  }

  for (const dirName of sessionDirs) {
    const sessionDir = path.join(SESSION_STATE_DIR, dirName);
    try {
      if (!fs.statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = parseWorkspaceYaml(sessionDir);
    if (!meta) continue;

    // Quick check: does events.jsonl exist?
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) continue;

    // Read events for summary extraction and message count
    const events = await readJsonlFile<CopilotEvent>(eventsPath);
    const userMessages = events.filter((e) => e.type === 'user.message');
    const assistantMessages = events.filter((e) => e.type === 'assistant.message');
    const bubbleCount = userMessages.length + assistantMessages.length;
    if (bubbleCount === 0) continue;

    // Extract first user message for summary
    const firstUser = userMessages[0];
    const summary = meta.summary || cleanPrompt(firstUser?.data?.content);

    const updatedAt = meta.updated_at
      ? new Date(meta.updated_at)
      : meta.created_at
        ? new Date(meta.created_at)
        : new Date(0);

    entries.push({
      id: meta.id || dirName,
      source: 'copilot',
      cwd: meta.cwd || '',
      updatedAt,
      summary: summary ?? undefined,
      filePath: sessionDir,
    });
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'copilot',
  label: 'Copilot CLI',
  color: '#000000',
  find: findCopilotSessions,
  parse: parseCopilotSession,
});
