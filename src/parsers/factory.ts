import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import type {
  NormalizedSession,
  NormalizedMessage,
  SessionMetadata,
  SessionStats,
  SessionListEntry,
} from '../types.js';
import {
  readJsonlFile,
  readJsonFile,
  scanJsonlHead,
  getFileStats,
} from './common.js';
import {
  explodeAssistantBlocks,
  explodeUserBlocks,
  indexMessages,
  cleanPrompt,
  type RawBlock,
  type ExplodedMessage,
} from './explosion.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_SUBDIR = 'sessions';
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'Create', 'NotebookEdit']);
const PATCH_FILE_RE = /\*{3}\s+(?:Add|Update|Delete)\s+File:\s+(.+)/g;

// ── Raw event shapes (loosely typed for resilience) ─────────────────────────

interface FactorySessionStart {
  type: 'session_start';
  id?: string;
  cwd?: string;
  title?: string;
  sessionTitle?: string;
  owner?: string;
  version?: number;
}

interface FactoryMessageEvent {
  type: 'message';
  id?: string;
  timestamp?: string;
  parentId?: string;
  message?: {
    role?: 'user' | 'assistant';
    content?: RawBlock[];
    visibility?: 'hidden' | 'normal';
  };
}

interface FactoryEvent {
  type?: string;
  timestamp?: string;
  [k: string]: unknown;
}

interface FactorySettings {
  model?: string;
  reasoningEffort?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    thinkingTokens?: number;
  };
}

// ── Home / directory helpers ────────────────────────────────────────────────

function getFactoryHome(): string {
  const env = process.env['FACTORY_HOME'];
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.factory');
}

function getSessionsDir(): string {
  return path.join(getFactoryHome(), SESSIONS_SUBDIR);
}

// Factory encodes the project cwd as a dir name by replacing `/` with `-`,
// so `/Users/x/dev/y` becomes `-Users-x-dev-y`. Reverse it.
function decodeProjectDir(dirName: string): string {
  return dirName.startsWith('-') ? '/' + dirName.slice(1).replace(/-/g, '/') : dirName;
}

// ── Patch parsing for ApplyPatch tool ───────────────────────────────────────

function extractFilesFromPatch(input: string): string[] {
  const files: string[] = [];
  PATCH_FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATCH_FILE_RE.exec(input)) !== null) {
    const filePath = m[1]?.trim();
    if (filePath && !files.includes(filePath)) files.push(filePath);
  }
  return files;
}

// ── Stats computation ───────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  settings: FactorySettings | null,
): SessionStats {
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; errors: number }>();
  const filesModifiedSet = new Set<string>();
  const toolUseIdToName = new Map<string, string>();

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

        if (block.id) toolUseIdToName.set(block.id, block.name);

        if (FILE_MODIFYING_TOOLS.has(block.name)) {
          const filePath = block.input?.['file_path'];
          if (typeof filePath === 'string') filesModifiedSet.add(filePath);
        } else if (block.name === 'ApplyPatch') {
          // Factory's ApplyPatch wraps the patch string under input.input.
          const inner = block.input?.['input'];
          if (typeof inner === 'string') {
            for (const f of extractFilesFromPatch(inner)) filesModifiedSet.add(f);
          }
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
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

  // Tokens come from the sidecar .settings.json (Factory only tracks per-session totals)
  let tokenUsage: SessionStats['tokenUsage'] | undefined;
  if (settings?.tokenUsage) {
    const t = settings.tokenUsage;
    const input = t.inputTokens ?? 0;
    const output = t.outputTokens ?? 0;
    const cacheRead = t.cacheReadTokens ?? 0;
    const cacheCreation = t.cacheCreationTokens ?? 0;
    const thinking = t.thinkingTokens ?? 0;
    if (input || output || cacheRead || cacheCreation || thinking) {
      tokenUsage = {
        input,
        output,
        cacheRead: cacheRead || undefined,
        cacheCreation: cacheCreation || undefined,
        thinking: thinking || undefined,
      };
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
    tokenUsage,
    toolFrequency,
    filesModified: Array.from(filesModifiedSet).sort(),
    durationMs,
  };
}

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseFactorySession(filePath: string): Promise<NormalizedSession> {
  const events = await readJsonlFile<FactoryEvent>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  const startEvent = events.find((e) => e.type === 'session_start') as
    | FactorySessionStart
    | undefined;
  const sessionId = startEvent?.id ?? path.basename(filePath, '.jsonl');
  const cwd =
    startEvent?.cwd ?? decodeProjectDir(path.basename(path.dirname(filePath)));

  const settingsPath = filePath.replace(/\.jsonl$/, '.settings.json');
  const settings = await readJsonFile<FactorySettings>(settingsPath);

  // Track timestamps across ALL events (skipped ones included) so createdAt/updatedAt
  // span the full session, not just the visible message range. Mirrors claude.ts:593-603.
  let firstTs: Date | undefined;
  let lastTs: Date | undefined;
  const noteTs = (s: unknown): void => {
    if (typeof s !== 'string') return;
    const t = new Date(s);
    if (isNaN(+t)) return;
    if (!firstTs || t < firstTs) firstTs = t;
    if (!lastTs || t > lastTs) lastTs = t;
  };

  const exploded: ExplodedMessage[] = [];
  events.forEach((ev, lineIdx) => {
    noteTs(ev.timestamp);

    // Skip everything except `message` events. `todo_state` and `compaction_state`
    // are scaffolding/summarization records — same treatment as Claude's
    // isMeta-without-content and isCompactSummary skips (src/parsers/claude.ts:194-219).
    if (ev.type !== 'message') return;

    const m = ev as FactoryMessageEvent;
    const ts = m.timestamp ? new Date(m.timestamp) : firstTs ?? new Date();
    const role = m.message?.role;
    const blocks = Array.isArray(m.message?.content) ? m.message!.content! : [];

    if (role === 'assistant') {
      exploded.push(...explodeAssistantBlocks(blocks, ts, lineIdx));
    } else if (role === 'user') {
      // Factory marks system reminders / context injections with visibility:'hidden'.
      // explodeUserBlocks already filters <system-reminder>-style text via
      // isSystemInjectedText, but the explicit flag is the cleaner signal here.
      if (m.message?.visibility === 'hidden') return;
      exploded.push(...explodeUserBlocks(blocks, ts, lineIdx));
    }
  });

  const messages = indexMessages(exploded);

  const metadata: SessionMetadata = {
    cwd,
    model: settings?.model,
    createdAt: firstTs ?? new Date(0),
    updatedAt: lastTs ?? firstTs ?? new Date(0),
    fileBytes,
    rawLineCount,
  };

  const stats = computeStats(messages, settings);

  return {
    id: sessionId,
    source: 'factory',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function findFactorySessions(): Promise<SessionListEntry[]> {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const entries: SessionListEntry[] = [];

  for (const projectDirent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!projectDirent.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectDirent.name);
    const cwdFromDir = decodeProjectDir(projectDirent.name);

    let fnames: string[];
    try {
      fnames = fs.readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const fname of fnames) {
      if (!fname.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, fname);
      const sessionId = fname.replace(/\.jsonl$/, '');

      let summary: string | undefined;
      let cwd = cwdFromDir;
      let updatedAt: Date | undefined;
      let foundStart = false;
      let foundFirstUser = false;

      try {
        await scanJsonlHead(filePath, 50, (parsed: unknown) => {
          const obj = parsed as FactoryEvent;

          if (typeof obj.timestamp === 'string') {
            const t = new Date(obj.timestamp);
            if (!isNaN(+t)) updatedAt = t;
          }

          if (obj.type === 'session_start' && !foundStart) {
            foundStart = true;
            const s = obj as FactorySessionStart;
            if (s.cwd) cwd = s.cwd;
            if (!summary) summary = cleanPrompt(s.title) ?? cleanPrompt(s.sessionTitle) ?? undefined;
          }

          if (obj.type === 'message' && !foundFirstUser) {
            const m = obj as FactoryMessageEvent;
            if (m.message?.role === 'user' && m.message.visibility !== 'hidden') {
              const firstText = (m.message.content || []).find(
                (b) => b.type === 'text',
              )?.text;
              const cleaned = cleanPrompt(firstText);
              if (cleaned) {
                summary = cleaned;
                foundFirstUser = true;
              }
            }
          }

          return 'continue';
        });
      } catch {
        // Skip unreadable / partial files silently
        continue;
      }

      if (!updatedAt) {
        try {
          updatedAt = fs.statSync(filePath).mtime;
        } catch {
          continue;
        }
      }

      entries.push({
        id: sessionId,
        source: 'factory',
        cwd,
        updatedAt,
        summary,
        filePath,
      });
    }
  }

  entries.sort((a, b) => +b.updatedAt - +a.updatedAt);
  return entries;
}

// ── Register ────────────────────────────────────────────────────────────────

registerSource({
  name: 'factory',
  label: 'Factory',
  color: '#7C3AED',
  getDataDir: getSessionsDir,
  find: findFactorySessions,
  parse: parseFactorySession,
});
