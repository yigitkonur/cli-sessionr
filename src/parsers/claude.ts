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
import { readJsonlFile, scanJsonlHead, getFileStats } from './common.js';
import { registerSource } from './registry.js';

// ── Raw JSONL types ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'Create', 'NotebookEdit']);

type RawType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'queue-operation'
  | 'file-history-snapshot'
  | 'progress'
  | 'last-prompt';

interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  signature?: string;
  [key: string]: unknown;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawMessage {
  role?: string;
  content?: string | RawBlock[];
  usage?: RawUsage;
  model?: string;
}

interface RawLine {
  type: RawType;
  uuid: string;
  timestamp: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  isCompactSummary?: boolean;
  isMeta?: boolean;
  message?: RawMessage;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getClaudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

function getProjectsDir(): string {
  return path.join(getClaudeConfigDir(), 'projects');
}

/**
 * Extract text from a tool_result content field which can be either a string
 * or an array of text blocks.
 */
function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && b.text)
      .map((b: { text?: string }) => b.text!)
      .join('\n');
  }
  return '';
}

/**
 * Return true if a text block looks like system-injected content rather than
 * real user input. Checks for specific known system XML tag prefixes that
 * Claude Code or its harness injects into user messages.
 */
function isSystemInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<permissions') ||
    trimmed.startsWith('<context_window') ||
    trimmed.startsWith('<user_instructions>')
  );
}

/**
 * Strip system-reminder blocks, XML tags, collapse whitespace, and truncate
 * to produce a clean human-readable prompt summary. Mirrors agentlytics'
 * cleanPrompt() logic.
 */
function cleanPrompt(prompt: string | null | undefined): string | undefined {
  if (!prompt || prompt === 'No prompt') return undefined;
  const clean = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || undefined;
}

// ── Metadata extraction ──────────────────────────────────────────────────────

interface ExtractedMetadata {
  sessionId?: string;
  cwd: string;
  gitBranch?: string;
  model?: string;
  hasCompactSummary: boolean;
}

function extractMetadata(lines: RawLine[]): ExtractedMetadata {
  let sessionId: string | undefined;
  let cwd = '';
  let gitBranch: string | undefined;
  let model: string | undefined;
  let hasCompactSummary = false;

  for (const line of lines) {
    if (!sessionId && line.sessionId) sessionId = line.sessionId;
    if (!cwd && line.cwd) cwd = line.cwd;
    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;

    // Model can be on the line itself or inside message
    if (!model && line.model) model = line.model;
    if (!model && line.message?.model) model = line.message.model;

    if (line.isCompactSummary) hasCompactSummary = true;
  }

  return { sessionId, cwd, gitBranch, model, hasCompactSummary };
}

// ── Deduplication ────────────────────────────────────────────────────────────

/**
 * Claude writes partial assistant messages as multiple JSONL lines with the
 * same UUID but growing content. Keep only the last entry per UUID.
 */
function deduplicateByUuid(lines: RawLine[]): RawLine[] {
  const lastIndex = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const uuid = lines[i]!.uuid;
    if (uuid) {
      lastIndex.set(uuid, i);
    }
  }

  return lines.filter((line, i) => {
    const uuid = line.uuid;
    if (!uuid) return true; // keep lines without UUIDs (shouldn't happen, but safe)
    return lastIndex.get(uuid) === i;
  });
}

// ── Message explosion ────────────────────────────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function shouldSkipLine(line: RawLine): boolean {
  // Skip non-conversation types
  if (
    line.type === 'system' ||
    line.type === 'queue-operation' ||
    line.type === 'file-history-snapshot' ||
    line.type === 'progress' ||
    line.type === 'last-prompt'
  ) {
    return true;
  }

  // Skip meta messages with no real content or with system-injected content
  if (line.isMeta) {
    if (!line.message?.content) return true;
    // isMeta user messages with string content starting with < are system-injected
    if (typeof line.message.content === 'string' && isSystemInjectedText(line.message.content)) {
      return true;
    }
  }

  // Skip compact summaries (just note for metadata)
  if (line.isCompactSummary) return true;

  return false;
}

function explodeAssistantMessage(line: RawLine, lineIndex: number): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const ts = new Date(line.timestamp);
  const content = line.message?.content;

  if (!content || typeof content === 'string') {
    // Simple string content (unusual for assistant but handle it)
    const text = typeof content === 'string' ? content : '';
    if (text) {
      results.push({
        role: 'assistant',
        content: text,
        blocks: [{ type: 'text', text }],
        timestamp: ts,
        rawLineIndex: lineIndex,
      });
    }
    return results;
  }

  // Array of blocks — group text+thinking together, explode tool_use separately
  const textBlocks: ContentBlock[] = [];
  let textContent = '';

  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = block.text || '';
        if (text.trim()) {
          textBlocks.push({ type: 'text', text });
          textContent += (textContent ? '\n' : '') + text;
        }
        break;
      }

      case 'thinking': {
        const text = block.thinking || block.text || '';
        if (text.trim()) {
          textBlocks.push({ type: 'thinking', text });
        }
        break;
      }

      case 'tool_use': {
        // Flush accumulated text+thinking as one assistant message before tool_use
        if (textBlocks.length > 0) {
          // If no text content but has thinking blocks, use thinking summary as content
          let flushedContent = textContent;
          if (!flushedContent) {
            const thinkingTexts = textBlocks
              .filter((b) => b.type === 'thinking')
              .map((b) => (b as { type: 'thinking'; text: string }).text);
            if (thinkingTexts.length > 0) {
              flushedContent = '[thinking] ' + thinkingTexts[0].slice(0, 200);
            }
          }
          results.push({
            role: 'assistant',
            content: flushedContent,
            blocks: [...textBlocks],
            timestamp: ts,
            rawLineIndex: lineIndex,
          });
          textBlocks.length = 0;
          textContent = '';
        }

        const toolBlock: ContentBlock = {
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: (block.input as Record<string, unknown>) || {},
        };
        results.push({
          role: 'tool_use',
          content: `Tool: ${block.name || 'unknown'}`,
          blocks: [toolBlock],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      // tool_result blocks can appear in assistant messages in some edge cases
      case 'tool_result': {
        const resultContent = extractToolResultContent(block.content);
        const resultBlock: ContentBlock = {
          type: 'tool_result',
          toolUseId: block.tool_use_id || '',
          content: resultContent,
          isError: block.is_error === true,
        };
        results.push({
          role: 'tool_result',
          content: resultContent,
          blocks: [resultBlock],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      default:
        // Unknown block type — skip silently
        break;
    }
  }

  // Flush any remaining text+thinking blocks
  if (textBlocks.length > 0) {
    let flushedContent = textContent;
    if (!flushedContent) {
      const thinkingTexts = textBlocks
        .filter((b) => b.type === 'thinking')
        .map((b) => (b as { type: 'thinking'; text: string }).text);
      if (thinkingTexts.length > 0) {
        flushedContent = '[thinking] ' + thinkingTexts[0].slice(0, 200);
      }
    }
    results.push({
      role: 'assistant',
      content: flushedContent,
      blocks: [...textBlocks],
      timestamp: ts,
      rawLineIndex: lineIndex,
    });
  }

  return results;
}

function explodeUserMessage(line: RawLine, lineIndex: number): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const ts = new Date(line.timestamp);
  const content = line.message?.content;

  if (!content) return results;

  // Simple string content
  if (typeof content === 'string') {
    if (content.trim()) {
      results.push({
        role: 'user',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: ts,
        rawLineIndex: lineIndex,
      });
    }
    return results;
  }

  // Array of blocks — explode
  const textBlocks: string[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'tool_result': {
        const resultContent = extractToolResultContent(block.content);
        const resultBlock: ContentBlock = {
          type: 'tool_result',
          toolUseId: block.tool_use_id || '',
          content: resultContent,
          isError: block.is_error === true,
        };
        results.push({
          role: 'tool_result',
          content: resultContent,
          blocks: [resultBlock],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'text': {
        const text = block.text || '';
        if (text.trim() && !isSystemInjectedText(text)) {
          textBlocks.push(text);
        }
        break;
      }

      default:
        break;
    }
  }

  // Combine real user text blocks into a single user message
  if (textBlocks.length > 0) {
    const joined = textBlocks.join('\n');
    results.push({
      role: 'user',
      content: joined,
      blocks: textBlocks.map((t) => ({ type: 'text' as const, text: t })),
      timestamp: ts,
      rawLineIndex: lineIndex,
    });
  }

  return results;
}

// ── Stats computation ────────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  dedupedLines: RawLine[],
): SessionStats {
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};
  const toolCounts = new Map<string, { count: number; errors: number }>();
  const filesModifiedSet = new Set<string>();

  // Map tool_use id -> tool name for O(1) error attribution
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

        // Index tool_use id for error attribution later
        if (block.id) {
          toolUseIdToName.set(block.id, block.name);
        }

        // Track modified files
        if (FILE_MODIFYING_TOOLS.has(block.name)) {
          const filePath = block.input?.['file_path'];
          if (typeof filePath === 'string') {
            filesModifiedSet.add(filePath);
          }
        }
      }
    }
  }

  // Count errors from tool_result blocks — O(1) lookup via toolUseIdToName
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

  // Token usage from deduplicated assistant lines only (avoids double-counting
  // partial messages that share the same UUID with their final version)
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;

  for (const line of dedupedLines) {
    if (line.type === 'assistant' && line.message?.usage) {
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

  return {
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
}

// ── Main parser ──────────────────────────────────────────────────────────────

export async function parseClaudeSession(filePath: string): Promise<NormalizedSession> {
  // 1. Read all JSONL lines
  const rawLines = await readJsonlFile<RawLine>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  // 2. Deduplicate by UUID (last entry wins)
  const deduped = deduplicateByUuid(rawLines);

  // 3. Extract metadata from early messages
  const meta = extractMetadata(deduped);

  // 4. Build NormalizedMessage[] with content block explosion
  const exploded: ExplodedMessage[] = [];

  for (let i = 0; i < deduped.length; i++) {
    const line = deduped[i]!;

    if (shouldSkipLine(line)) continue;

    if (line.type === 'assistant') {
      exploded.push(...explodeAssistantMessage(line, i));
    } else if (line.type === 'user') {
      exploded.push(...explodeUserMessage(line, i));
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

  // 5. Timestamps for metadata — use raw event timestamps so system lines
  //    that get filtered don't shift createdAt forward
  const rawTimestamps = deduped
    .map((l) => new Date(l.timestamp).getTime())
    .filter((t) => !isNaN(t));
  const msgTimestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
  const createdAt = rawTimestamps.length > 0
    ? new Date(Math.min(...rawTimestamps))
    : (msgTimestamps.length > 0 ? new Date(Math.min(...msgTimestamps)) : new Date());
  const updatedAt = rawTimestamps.length > 0
    ? new Date(Math.max(...rawTimestamps))
    : (msgTimestamps.length > 0 ? new Date(Math.max(...msgTimestamps)) : new Date());

  // Session ID from the filename (UUID) or sessionId field
  const basename = path.basename(filePath, '.jsonl');
  const sessionId = meta.sessionId || basename;

  // 6. Compute stats from deduplicated raw lines (for token usage)
  const stats = computeStats(messages, deduped);

  const metadata: SessionMetadata = {
    cwd: meta.cwd || path.dirname(filePath),
    gitBranch: meta.gitBranch,
    model: meta.model,
    createdAt,
    updatedAt,
    fileBytes,
    rawLineCount,
  };

  return {
    id: sessionId,
    source: 'claude',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ────────────────────────────────────────────────────────

export async function findClaudeSessions(): Promise<SessionListEntry[]> {
  const projectsDir = getProjectsDir();

  if (!fs.existsSync(projectsDir)) return [];

  const entries: SessionListEntry[] = [];

  // Iterate project directories (each encodes a project path, e.g. -Users-me-Code-foo)
  let projDirs: fs.Dirent[];
  try {
    projDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const projDirent of projDirs) {
    if (!projDirent.isDirectory()) continue;
    const projDir = path.join(projectsDir, projDirent.name);

    // Decode folder path from directory name (e.g. -Users-me-Code-foo -> /Users/me/Code/foo)
    const decodedFolder = projDirent.name.replace(/-/g, '/');

    // Try reading sessions-index.json for pre-computed metadata
    const indexed = new Map<string, {
      sessionId: string;
      firstPrompt?: string;
      created?: string;
      modified?: string;
      messageCount?: number;
      projectPath?: string;
      gitBranch?: string;
    }>();

    const indexPath = path.join(projDir, 'sessions-index.json');
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const entry of indexData.entries || []) {
        if (entry.sessionId) {
          indexed.set(entry.sessionId, entry);
        }
      }
    } catch {
      // No index file or invalid JSON — fall back to scanning
    }

    // Scan all .jsonl files in this project directory
    let files: string[];
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = path.basename(file, '.jsonl');
      const filePath = path.join(projDir, file);
      const indexEntry = indexed.get(sessionId);

      if (indexEntry) {
        // Use index metadata — no need to scan the JSONL file
        const updatedAt = indexEntry.modified
          ? new Date(indexEntry.modified)
          : new Date(0);

        entries.push({
          id: sessionId,
          source: 'claude',
          cwd: indexEntry.projectPath || decodedFolder,
          updatedAt,
          summary: cleanPrompt(indexEntry.firstPrompt),
          filePath,
        });
      } else {
        // Orphan .jsonl not in index — fall back to head scanning
        let cwd = '';
        let updatedAt = new Date(0);
        let summary: string | undefined;

        await scanJsonlHead(filePath, 30, (parsed) => {
          const line = parsed as RawLine;

          if (!cwd && line.cwd) cwd = line.cwd;

          const ts = line.timestamp ? new Date(line.timestamp) : null;
          if (ts && !isNaN(ts.getTime()) && ts.getTime() > updatedAt.getTime()) {
            updatedAt = ts;
          }

          // Try to get a summary from the first user message
          if (!summary && line.type === 'user' && line.message?.content) {
            const content = line.message.content;
            if (typeof content === 'string') {
              summary = cleanPrompt(content);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text && !isSystemInjectedText(block.text)) {
                  summary = cleanPrompt(block.text);
                  break;
                }
              }
            }
          }

          // Once we have all needed info, stop early
          if (cwd && summary) return 'stop';
          return 'continue';
        });

        // Get the actual file mtime for updatedAt if we only got early timestamps
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtime.getTime() > updatedAt.getTime()) {
            updatedAt = stat.mtime;
          }
        } catch {
          // ignore
        }

        entries.push({
          id: sessionId,
          source: 'claude',
          cwd: cwd || decodedFolder,
          updatedAt,
          summary,
          filePath,
        });
      }

      // Remove from indexed so we can track what's left
      indexed.delete(sessionId);
    }
  }

  // Sort by updatedAt descending (most recent first)
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'claude',
  label: 'Claude Code',
  color: '#4A90D9',
  find: findClaudeSessions,
  parse: parseClaudeSession,
});
