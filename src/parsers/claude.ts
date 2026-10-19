import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {
  ContentBlock,
  MessageSource,
  NormalizedMessage,
  NormalizedSession,
  SessionListEntry,
  SessionMetadata,
  SessionStats,
  CompactionMeta,
  MessageUsage,
  TurnEndEvent,
} from '../types.js';
import { readJsonlFile, readJsonlFileWithLineIndex, scanJsonlHead, getFileStats } from './common.js';
import { registerSource } from './registry.js';
import { deriveContextWindow } from '../turns.js';

// ── Raw JSONL types ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'Create', 'NotebookEdit']);

type RawType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'attachment'
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
  id?: string;
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
  rawLineIndex?: number;
  attachment?: {
    type?: string;
    prompt?: unknown;
    timestamp?: string;
    commandMode?: string;
    isMeta?: boolean;
    origin?: { kind?: string };
    [key: string]: unknown;
  };
  durationMs?: number;
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
      .filter((b): b is { type: 'text'; text: string } =>
        b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
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
  reasoningEffort?: string;
  hasCompactSummary: boolean;
}

function extractMetadata(lines: RawLine[]): ExtractedMetadata {
  let sessionId: string | undefined;
  let cwd = '';
  let gitBranch: string | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let hasCompactSummary = false;

  for (const line of lines) {
    if (!sessionId && line.sessionId) sessionId = line.sessionId;
    if (!cwd && line.cwd) cwd = line.cwd;
    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;

    const reportedModel = line.message?.model || line.model;
    if (reportedModel && reportedModel !== '<synthetic>') model = reportedModel;
    const effort = line.effort ?? line.perTurnEffort ?? line.reasoning_effort;
    if (typeof effort === 'string') reasoningEffort = effort;

    if (line.isCompactSummary) hasCompactSummary = true;
  }

  return { sessionId, cwd, gitBranch, model, reasoningEffort, hasCompactSummary };
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
  usage?: MessageUsage;
  contextTokens?: number;
  kind?: string;
  compactionMeta?: CompactionMeta;
  model?: string;
  contextWindow?: number;
  reasoningEffort?: string;
  source?: MessageSource;
  originKind?: string;
}

export function classifyUserSource(text: string, line: RawLine): MessageSource {
  if (line.source && typeof line.source === 'string') {
    return line.source as MessageSource;
  }
  if (line.promptSource && typeof line.promptSource === 'string') {
    if (line.origin && (line.origin as any).kind === 'task-notification') {
      return 'task_notification';
    }
    if (line.promptSource === 'system') {
      return 'system';
    }
  }
  if (line.origin && (line.origin as any).kind === 'task-notification') {
    return 'task_notification';
  }
  if (line.type === 'attachment' && (line as any).attachment?.type === 'queued_command') {
    return 'queued';
  }
  const trimmed = text.trim();
  if (/^\[Request interrupted by user(?: for tool use(?: "[^"\n]+")?)?\]$/.test(trimmed)) {
    return 'interrupt';
  }
  // Explicit human provenance wins over heuristics for conversational text.
  if ((line.origin as { kind?: string } | undefined)?.kind === 'human') {
    return 'prompt';
  }
  if (trimmed.startsWith('<task-notification') || trimmed.startsWith('<task-id>')) {
    return 'task_notification';
  }
  if (
    trimmed.startsWith('<command-name>') ||
    trimmed.startsWith('<command-message>') ||
    trimmed.startsWith('<command-args>') ||
    trimmed.startsWith('<local-command-') ||
    line.subtype === 'local_command' ||
    /^\/(compact|clear|model|effort|config|copy|export|doctor|cost)(\s|$|<)/.test(trimmed)
  ) {
    return 'local_command';
  }
  if (
    line.isMeta ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<system-reminder>') ||
    /^<agent-message(?:\s|>)/.test(trimmed) ||
    /^Another Claude session sent a message:\s*<teammate-message(?:\s|>)/.test(trimmed) ||
    trimmed.startsWith('This session is being continued from a previous conversation')
  ) {
    return 'system';
  }
  return 'prompt';
}

function isCompactionLine(line: RawLine): boolean {
  return (
    line.kind === 'compaction' ||
    line.subtype === 'compact_boundary' ||
    line.subtype === 'compaction' ||
    Boolean(line.isCompactSummary) ||
    Boolean(line.compactionMeta) ||
    Boolean((line as any).compactMetadata)
  );
}

function shouldSkipLine(line: RawLine): boolean {
  // Never skip compaction records!
  if (isCompactionLine(line)) {
    return false;
  }

  // Allow queued_command attachments mid-turn
  if (line.type === 'attachment') {
    if (line.isMeta || line.attachment?.isMeta) return true;
    const mode = line.attachment?.commandMode;
    return line.attachment?.type !== 'queued_command' ||
      (mode !== undefined && mode !== 'prompt' && mode !== 'task-notification');
  }

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

  // Skip compact summaries (handled in compaction explosion)
  if (line.isCompactSummary) return true;

  return false;
}

function compactionSummary(line: RawLine): string | undefined {
  const content = line.message?.content;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const text = content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    return text || undefined;
  }
  return undefined;
}

function explodeCompactionMessage(
  line: RawLine,
  lineIndex: number,
  overrideSummary?: string,
): ExplodedMessage[] {
  const ts = line.timestamp ? new Date(line.timestamp) : new Date();

  const rawMeta = (line.compactionMeta || (line as any).compactMetadata || {}) as {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
  };

  const trigger = typeof rawMeta.trigger === 'string' ? rawMeta.trigger : undefined;
  const preTokens = typeof rawMeta.preTokens === 'number' ? rawMeta.preTokens : undefined;
  const postTokens = typeof rawMeta.postTokens === 'number' ? rawMeta.postTokens : undefined;
  const summary = overrideSummary ?? (typeof rawMeta.summary === 'string' ? rawMeta.summary : undefined) ?? compactionSummary(line);
  const content = `Context compacted${preTokens !== undefined && postTokens !== undefined ? ` from ${preTokens} to ${postTokens} tokens` : ''}`;

  return [
    {
      role: 'system',
      content,
      blocks: [{ type: 'text', text: content }],
      timestamp: ts,
      rawLineIndex: lineIndex,
      kind: 'compaction',
      compactionMeta: {
        trigger,
        preTokens,
        postTokens,
        summary,
      },
    },
  ];
}

function explodeAttachmentMessage(line: RawLine, lineIndex: number): ExplodedMessage[] {
  const ts = new Date(line.attachment?.timestamp || line.timestamp);
  const extracted = extractToolResultContent(line.attachment?.prompt);
  const prompt = extracted.trim() ? extracted : '[queued command]';
  const trimmedPrompt = prompt.trimStart();
  const notification =
    line.attachment?.commandMode === 'task-notification' ||
    line.attachment?.origin?.kind === 'task-notification' ||
    trimmedPrompt.startsWith('<task-notification') ||
    trimmedPrompt.startsWith('<task-id>');
  return [
    {
      role: notification ? 'system' : 'user',
      content: prompt,
      blocks: [{ type: 'text', text: prompt }],
      timestamp: ts,
      rawLineIndex: typeof line.rawLineIndex === 'number' ? line.rawLineIndex : lineIndex,
      source: notification ? 'task_notification' : 'queued',
      ...(typeof line.attachment?.origin?.kind === 'string'
        ? { originKind: line.attachment.origin.kind } : {}),
    },
  ];
}

function explodeAssistantMessage(line: RawLine, lineIndex: number): ExplodedMessage[] {
  const actualLineIndex = typeof line.rawLineIndex === 'number' ? line.rawLineIndex : lineIndex;
  const results: ExplodedMessage[] = [];
  const ts = new Date(line.timestamp);
  const content = line.message?.content;

  const u = line.message?.usage;
  let usage: MessageUsage | undefined;
  let contextTokens: number | undefined;
  if (u) {
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const readTok = u.cache_read_input_tokens || 0;
    const createTok = u.cache_creation_input_tokens || 0;
    contextTokens = inTok + readTok + createTok;
    usage = {
      input_tokens: inTok,
      output_tokens: outTok,
      cache_read_input_tokens: readTok,
      cache_creation_input_tokens: createTok,
      context_tokens: contextTokens,
    };
  }

  if (!content || typeof content === 'string') {
    // Simple string content (unusual for assistant but handle it)
    const text = typeof content === 'string' ? content : '';
    if (text) {
      results.push({
        role: 'assistant',
        content: text,
        blocks: [{ type: 'text', text }],
        timestamp: ts,
        rawLineIndex: actualLineIndex,
        usage,
        contextTokens,
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
            rawLineIndex: actualLineIndex,
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
          rawLineIndex: actualLineIndex,
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
          rawLineIndex: actualLineIndex,
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
      rawLineIndex: actualLineIndex,
    });
  }

  if (usage && results.length > 0) {
    const asst = results.find((r) => r.role === 'assistant') ?? results[0];
    if (asst) {
      asst.usage = usage;
      asst.contextTokens = contextTokens;
    }
  }

  return results;
}

function explodeUserMessage(line: RawLine, lineIndex: number): ExplodedMessage[] {
  const actualLineIndex = typeof line.rawLineIndex === 'number' ? line.rawLineIndex : lineIndex;
  const results: ExplodedMessage[] = [];
  const ts = new Date(line.timestamp);
  const content = line.message?.content;

  if (!content) return results;

  // Simple string content
  if (typeof content === 'string') {
    if (content.trim()) {
      const source = classifyUserSource(content, line);
      results.push({
        role: source === 'system' || source === 'task_notification' ? 'system' : 'user',
        content,
        blocks: [{ type: 'text', text: content }],
        timestamp: ts,
        rawLineIndex: actualLineIndex,
        source,
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
          rawLineIndex: actualLineIndex,
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
    const source = classifyUserSource(joined, line);
    results.push({
      role: source === 'system' || source === 'task_notification' ? 'system' : 'user',
      content: joined,
      blocks: textBlocks.map((t) => ({ type: 'text' as const, text: t })),
      timestamp: ts,
      rawLineIndex: actualLineIndex,
      source,
    });
  }

  return results;
}

// ── Stats computation ────────────────────────────────────────────────────────

function collectTurnEnds(lines: RawLine[]): TurnEndEvent[] {
  const turnEnds: TurnEndEvent[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (
      line.type === 'system' &&
      line.subtype === 'turn_duration'
    ) {
      const dur =
        typeof line.durationMs === 'number'
          ? line.durationMs
          : typeof (line as any).duration_ms === 'number'
            ? (line as any).duration_ms
            : undefined;
      const timestamp = new Date(line.timestamp);
      // A malformed timestamp would later throw in toISOString(); skip the record instead.
      if (typeof dur === 'number' && Number.isFinite(dur) && dur >= 0 && !Number.isNaN(timestamp.getTime())) {
        turnEnds.push({
          timestamp,
          durationMs: dur,
          rawLineIndex: typeof line.rawLineIndex === 'number' ? line.rawLineIndex : lineIndex,
        });
      }
    }
  }

  return turnEnds;
}

function computeStats(
  messages: NormalizedMessage[],
  turnEnds: TurnEndEvent[],
  unattachedUsage: MessageUsage[] = [],
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
        // A message counts as a user prompt only if it is a prompt/queued steer AND not a non-human origin.
        if (
          (!msg.source || msg.source === 'prompt' || msg.source === 'queued') &&
          (!msg.originKind || msg.originKind === 'human')
        ) {
          byRole.user++;
        }
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

  // Usage is attached once per provider response, independently of content chunks.
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let contextTokens: number | undefined;

  for (const message of messages) {
    const u = message.usage;
    if (!u) continue;
    hasTokens = true;
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheCreation += u.cache_creation_input_tokens ?? 0;
    if (u.context_tokens !== undefined) contextTokens = u.context_tokens;
  }
  for (const u of unattachedUsage) {
    hasTokens = true;
    inputTokens += u.input_tokens ?? 0;
    outputTokens += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheCreation += u.cache_creation_input_tokens ?? 0;
  }

  // Aggregate the same completion events exposed on the normalized session.
  let durationMs: number | undefined;
  if (turnEnds.length > 0) {
    durationMs = turnEnds.reduce((sum, end) => sum + end.durationMs, 0);
  } else if (messages.length >= 2) {
    const first = messages[0]!.timestamp.getTime();
    const last = messages[messages.length - 1]!.timestamp.getTime();
    if (last > first) durationMs = last - first;
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  const compactionsCount = messages.filter((m) => m.kind === 'compaction' || m.compactionMeta !== undefined).length;

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
          contextTokens,
        }
      : undefined,
    toolFrequency,
    filesModified: Array.from(filesModifiedSet).sort(),
    durationMs,
    compactions: compactionsCount > 0 ? compactionsCount : undefined,
  };
}

// ── Main parser ──────────────────────────────────────────────────────────────

export async function parseClaudeSession(filePath: string): Promise<NormalizedSession> {
  // 1. Read all JSONL lines preserving physical line indices
  const rawLines = await readJsonlFileWithLineIndex<RawLine>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  // 2. Deduplicate by UUID (last entry wins)
  const deduped = deduplicateByUuid(rawLines);

  // 3. Extract metadata from early messages
  const isChildSession = filePath.split(path.sep).includes('subagents');
  const meta = extractMetadata(isChildSession ? deduped : deduped.filter(line => line.isSidechain !== true));

  // 4. Preserve content chunks, but let the final provider snapshot own usage.
  const exploded: ExplodedMessage[] = [];
  const usageLines = new Map<string | RawLine, RawLine>();
  const usageTargets = new Map<string | RawLine, ExplodedMessage>();
  const pairedSummaries = new Map<number, RawLine>();
  const consumedSummaries = new Set<RawLine>();
  let pendingBoundary: number | undefined;
  for (let i = 0; i < deduped.length; i++) {
    const line = deduped[i]!;
    if (line.isCompactSummary) {
      if (pendingBoundary !== undefined) {
        pairedSummaries.set(pendingBoundary, line);
        consumedSummaries.add(line);
      }
      pendingBoundary = undefined;
    } else if (isCompactionLine(line)) pendingBoundary = i;
    else if (line.type === 'user' || line.type === 'assistant') pendingBoundary = undefined;
  }
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let maxContext = 0;
  let contextWindow: number | undefined;

  for (let i = 0; i < deduped.length; i++) {
    const line = deduped[i]!;
    const ownUsage = line.isSidechain !== true || isChildSession;
    const reportedModel = line.message?.model || line.model;
    if (ownUsage && reportedModel && reportedModel !== '<synthetic>') model = reportedModel;
    const effort = line.effort ?? line.perTurnEffort ?? line.reasoning_effort;
    if (ownUsage && typeof effort === 'string') reasoningEffort = effort;
    const reportedUsage = ownUsage && line.type === 'assistant' && !line.isCompactSummary && reportedModel !== '<synthetic>' ? line.message?.usage : undefined;
    const u = reportedUsage && [reportedUsage.input_tokens, reportedUsage.output_tokens, reportedUsage.cache_read_input_tokens, reportedUsage.cache_creation_input_tokens].some(v => typeof v === 'number' && Number.isFinite(v)) ? reportedUsage : undefined;
    if (u) maxContext = Math.max(maxContext, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    const compact = line.compactMetadata as { preTokens?: number } | undefined;
    if (typeof compact?.preTokens === 'number') maxContext = Math.max(maxContext, compact.preTokens);
    contextWindow = model?.startsWith('claude-') && maxContext > 200_000 ? 1_000_000 : deriveContextWindow(model);

    if (shouldSkipLine(line) || consumedSummaries.has(line)) continue;

    let chunks: ExplodedMessage[];
    if (isCompactionLine(line)) {
      const paired = pairedSummaries.get(i);
      chunks = explodeCompactionMessage(line, i, paired ? compactionSummary(paired) : undefined);
    } else chunks = line.type === 'assistant' ? explodeAssistantMessage(line, i)
      : line.type === 'user' ? explodeUserMessage(line, i)
      : line.type === 'attachment' && line.attachment?.type === 'queued_command' ? explodeAttachmentMessage(line, i)
      : [];
    for (const chunk of chunks) {
      delete chunk.usage;
      delete chunk.contextTokens;
      chunk.model = model;
      chunk.reasoningEffort = reasoningEffort;
      chunk.contextWindow = contextWindow;
    }
    if (line.type === 'assistant' && !isCompactionLine(line)) {
      const key = line.message?.id || line.uuid || line;
      const target = chunks.find(m => m.role === 'assistant') ?? chunks[0];
      if (target) usageTargets.set(key, target);
      if (u) usageLines.set(key, line);
    }
    exploded.push(...chunks);
  }
  // A response with usage but nothing to render (empty or interrupted) has no message to carry it; it still
  // counts toward session totals, just not toward any turn.
  const unattachedUsage: MessageUsage[] = [];
  for (const [key, line] of usageLines) {
    const target = usageTargets.get(key);
    const u = line.message!.usage!;
    const usage: MessageUsage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      context_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    };
    if (!target) {
      unattachedUsage.push(usage);
      continue;
    }
    target.usage = usage;
    target.contextTokens = usage.context_tokens;
  }

  // Assign 1-based indexes
  const messages: NormalizedMessage[] = exploded.map((e, i) => {
    const m: NormalizedMessage = {
      index: i + 1,
      role: e.role,
      timestamp: e.timestamp,
      content: e.content,
      blocks: e.blocks,
      rawLineIndex: e.rawLineIndex,
      model: e.model,
      contextWindow: e.contextWindow,
      reasoningEffort: e.reasoningEffort,
      ...(e.source ? { source: e.source } : {}),
      ...(e.originKind ? { originKind: e.originKind } : {}),
    };
    if (e.usage) m.usage = e.usage;
    if (e.contextTokens !== undefined) m.contextTokens = e.contextTokens;
    if (e.kind) m.kind = e.kind;
    if (e.compactionMeta) m.compactionMeta = e.compactionMeta;
    return m;
  });

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
  const turnEnds = collectTurnEnds(deduped);
  const stats = computeStats(messages, turnEnds, unattachedUsage);

  const metadata: SessionMetadata = {
    cwd: meta.cwd || path.dirname(filePath),
    gitBranch: meta.gitBranch,
    model: meta.model,
    contextWindow,
    reasoningEffort: meta.reasoningEffort,
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
    turnEnds,
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
          isEmpty: (indexEntry.messageCount ?? 0) === 0,
        });
      } else {
        // Orphan .jsonl not in index — fall back to head scanning
        let cwd = '';
        let updatedAt = new Date(0);
        let summary: string | undefined;
        let sawConversation = false;

        await scanJsonlHead(filePath, 30, (parsed) => {
          const line = parsed as RawLine;

          if (!cwd && line.cwd) cwd = line.cwd;

          const ts = line.timestamp ? new Date(line.timestamp) : null;
          if (ts && !isNaN(ts.getTime()) && ts.getTime() > updatedAt.getTime()) {
            updatedAt = ts;
          }

          // Track whether we ever saw a non-system user/assistant exchange
          if (!sawConversation && !shouldSkipLine(line) &&
              (line.type === 'user' || line.type === 'assistant')) {
            sawConversation = true;
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
          isEmpty: !sawConversation,
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
  getDataDir: getProjectsDir,
  find: findClaudeSessions,
  parse: parseClaudeSession,
});
