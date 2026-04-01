/**
 * Command Code session parser.
 *
 * Storage layout:
 *   ~/.commandcode/projects/<encodedFolder>/<sessionId>.jsonl
 *   Optional sidecar: <sessionId>.meta.json (contains title)
 *
 * JSONL line format (same content block format as Claude Code):
 *   {type?: string, role: "user"|"assistant", timestamp: string,
 *    gitBranch?: string, content: [{type: "text"|"thinking"|"tool_use"|"tool_result", ...}]}
 *
 * Reuses explodeAssistantBlocks / explodeUserBlocks from explosion.ts.
 */

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
import { readJsonlFile, readJsonFile, getFileStats, scanJsonlHead } from './common.js';
import { registerSource } from './registry.js';
import {
  explodeAssistantBlocks,
  explodeUserBlocks,
  indexMessages,
  cleanPrompt,
  type RawBlock,
  type ExplodedMessage,
} from './explosion.js';

// ── Constants ──────────────────────────────────────────────────────────────

const COMMANDCODE_DIR = path.join(os.homedir(), '.commandcode');
const PROJECTS_DIR = path.join(COMMANDCODE_DIR, 'projects');
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'Create', 'NotebookEdit']);

// ── Raw JSONL types ────────────────────────────────────────────────────────

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawMessage {
  usage?: RawUsage;
  model?: string;
}

interface RawLine {
  type?: string;
  role?: 'user' | 'assistant' | 'system';
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  model?: string;
  content?: string | RawBlock[];
  message?: RawMessage;
  [key: string]: unknown;
}

interface MetaJson {
  title?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode folder path from Cursor/CommandCode directory name encoding.
 * Replaces `-` with `/` and prepends `/`.
 */
function decodeFolder(dirName: string): string {
  return '/' + dirName.replace(/-/g, '/');
}

/**
 * Extract the first user text from a raw line for use as session summary.
 */
function extractFirstPrompt(line: RawLine): string | null {
  if (line.role !== 'user') return null;
  const content = line.content;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (
      content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join(' ')
        .substring(0, 200) || null
    );
  }
  return null;
}

// ── Main parser ────────────────────────────────────────────────────────────

export async function parseCommandCodeSession(filePath: string): Promise<NormalizedSession> {
  const rawLines = await readJsonlFile<RawLine>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  // Read optional sidecar meta file
  const sessionId = path.basename(filePath, '.jsonl');
  const metaPath = path.join(path.dirname(filePath), `${sessionId}.meta.json`);
  const meta = await readJsonFile<MetaJson>(metaPath);

  // Extract metadata from lines
  let cwd = '';
  let gitBranch: string | undefined;
  let model: string | undefined;

  for (const line of rawLines) {
    if (!cwd && line.cwd) cwd = line.cwd;
    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;
    if (!model && line.model) model = line.model;
    if (!model && line.message?.model) model = line.message.model;
  }

  // If cwd is not in the JSONL, derive from directory structure
  if (!cwd) {
    const projDir = path.basename(path.dirname(filePath));
    cwd = decodeFolder(projDir);
  }

  // Build NormalizedMessage[] using shared explosion logic
  const exploded: ExplodedMessage[] = [];

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const line = rawLines[lineIdx]!;
    const content = line.content;

    if (!content || !line.role) continue;

    const ts = line.timestamp ? new Date(line.timestamp) : new Date();

    if (line.role === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) {
          exploded.push({
            role: 'assistant',
            content,
            blocks: [{ type: 'text', text: content }],
            timestamp: ts,
            rawLineIndex: lineIdx,
          });
        }
      } else if (Array.isArray(content)) {
        exploded.push(...explodeAssistantBlocks(content, ts, lineIdx));
      }
    } else if (line.role === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) {
          exploded.push({
            role: 'user',
            content,
            blocks: [{ type: 'text', text: content }],
            timestamp: ts,
            rawLineIndex: lineIdx,
          });
        }
      } else if (Array.isArray(content)) {
        exploded.push(...explodeUserBlocks(content, ts, lineIdx));
      }
    }
    // system role messages are skipped (same as Claude parser)
  }

  const messages = indexMessages(exploded);

  // Compute stats
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; errors: number }>();
  const filesModifiedSet = new Set<string>();
  const toolUseIdToName = new Map<string, string>();

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

        if (block.id) {
          toolUseIdToName.set(block.id, block.name);
        }

        // Track modified files
        if (FILE_MODIFYING_TOOLS.has(block.name)) {
          const fp = block.input?.['file_path'];
          if (typeof fp === 'string') {
            filesModifiedSet.add(fp);
          }
        }
      }
    }
  }

  // Count errors from tool_result blocks
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

  // Token usage from assistant lines
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;

  for (const line of rawLines) {
    if (line.role === 'assistant' && line.message?.usage) {
      const u = line.message.usage;
      if (u.input_tokens) {
        inputTokens += u.input_tokens;
        hasTokens = true;
      }
      if (u.output_tokens) {
        outputTokens += u.output_tokens;
        hasTokens = true;
      }
      if (u.cache_read_input_tokens) {
        cacheRead += u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        cacheCreation += u.cache_creation_input_tokens;
      }
    }
  }

  // Duration from first to last timestamp
  let durationMs: number | undefined;
  if (messages.length >= 2) {
    const first = messages[0]!.timestamp.getTime();
    const last = messages[messages.length - 1]!.timestamp.getTime();
    if (last > first) durationMs = last - first;
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  // Timestamps for metadata
  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
  const createdAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date();
  const updatedAt = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date();

  const metadata: SessionMetadata = {
    cwd,
    gitBranch,
    model,
    createdAt,
    updatedAt,
    fileBytes,
    rawLineCount,
  };

  const stats: SessionStats = {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    tokenUsage: hasTokens
      ? {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheRead || undefined,
          cacheCreation: cacheCreation || undefined,
        }
      : undefined,
    toolFrequency,
    filesModified: Array.from(filesModifiedSet).sort(),
    durationMs,
  };

  return {
    id: sessionId,
    source: 'commandcode',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ──────────────────────────────────────────────────────

export async function findCommandCodeSessions(): Promise<SessionListEntry[]> {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  let projDirs: string[];
  try {
    projDirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }

  const entries: SessionListEntry[] = [];

  for (const projDir of projDirs) {
    const dir = path.join(PROJECTS_DIR, projDir);

    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const decodedFolder = decodeFolder(projDir);

    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && !f.includes('.checkpoints.'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const fullPath = path.join(dir, file);
      const metaPath = path.join(dir, `${sessionId}.meta.json`);

      // Read optional meta.json for title
      let title: string | null = null;
      try {
        const metaContent = fs.readFileSync(metaPath, 'utf-8');
        const metaObj = JSON.parse(metaContent) as MetaJson;
        title = metaObj.title || null;
      } catch {
        // no meta
      }

      try {
        const stat = fs.statSync(fullPath);

        // Get timestamps and summary from head scan
        let firstTimestamp: Date | undefined;
        let lastTimestamp: Date | undefined;
        let summary: string | undefined;
        let gitBranchVal: string | undefined;

        await scanJsonlHead(fullPath, 30, (parsed, lineIndex) => {
          const line = parsed as RawLine;

          if (line.timestamp) {
            const ts = new Date(line.timestamp);
            if (!firstTimestamp) firstTimestamp = ts;
            lastTimestamp = ts;
          }

          if (!gitBranchVal && line.gitBranch) gitBranchVal = line.gitBranch;

          if (!summary && lineIndex === 0) {
            const prompt = extractFirstPrompt(line);
            if (prompt) {
              summary = cleanPrompt(prompt) ?? undefined;
            }
          }

          return 'continue';
        });

        // Use title from meta.json if available, otherwise use first prompt
        const displaySummary = title || summary;

        entries.push({
          id: sessionId,
          source: 'commandcode',
          cwd: decodedFolder,
          updatedAt: lastTimestamp || stat.mtime,
          summary: displaySummary ?? undefined,
          filePath: fullPath,
        });
      } catch {
        // skip
      }
    }
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ──────────────────────────────────────────────────────────────

registerSource({
  name: 'commandcode',
  label: 'Command Code',
  color: '#FF6B35',
  find: findCommandCodeSessions,
  parse: parseCommandCodeSession,
});
