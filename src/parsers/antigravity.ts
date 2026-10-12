import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedSession,
  SessionListEntry,
  SessionMetadata,
  SessionStats,
} from '../types.js';
import { readJsonlFile, getFileStats, resolveEnvPath, parseDefensiveTimestamp } from './common.js';
import { indexMessages, type ExplodedMessage } from './explosion.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const FILE_MODIFYING_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'str_replace_placeholder',
  'apply_patch',
  'edit_file',
  'Write',
  'Edit',
  'Create',
  'NotebookEdit',
]);

// ── Environment & Directory Helpers ──────────────────────────────────────────

export function getAntigravityDataDir(): string {
  const envVal =
    process.env['ANTIGRAVITY_APP_DATA_DIR'] ||
    process.env['ANTIGRAVITY_DATA_DIR'] ||
    process.env['ANTIGRAVITY_HOME'] ||
    process.env['GEMINI_CLI_HOME'];
  const defaultDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
  return resolveEnvPath(envVal, defaultDir);
}

export const getAntigravityDir = getAntigravityDataDir;

export function getAntigravityBrainDir(): string {
  return path.join(getAntigravityDataDir(), 'brain');
}

export function getAntigravityHistoryPath(): string {
  return path.join(getAntigravityDataDir(), 'history.jsonl');
}

// ── Prompt & Argument Helpers ────────────────────────────────────────────────

export function cleanAntigravityPrompt(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw;

  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch && reqMatch[1]) {
    text = reqMatch[1];
  } else {
    const briefMatch = text.match(/content=#\s*([^\n]+)/i) || text.match(/#\s*([^\n]+)/);
    if (briefMatch && briefMatch[1]) {
      text = briefMatch[1];
    }
  }

  text = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length > 120) {
    text = text.substring(0, 120);
  }
  return text || undefined;
}

export function extractUserPrompt(raw: string): string {
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

export function extractCwdValue(val: unknown): string | undefined {
  if (!val || typeof val !== 'string') return undefined;
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      s = JSON.parse(s);
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s || undefined;
}

/**
 * Safely unquotes JSON-stringified values or parses nested JSON structures/booleans.
 * Never throws on malformed or truncated inputs.
 */
export function unquoteValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        if (parsed === 'true') return true;
        if (parsed === 'false') return false;
        if (parsed === 'null') return null;
      }
      return parsed;
    } catch {
      if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1);
      }
      return value;
    }
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  return value;
}

/**
 * Normalizes tool arguments by unquoting all values and handling stringified dictionaries.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return normalizeToolArgs(parsed);
        }
      } catch {
        return { raw: args };
      }
    }
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    result[k] = unquoteValue(v);
  }

  // Dual-bridge: if questions array is present, populate singular question and options
  if (!result['question'] && Array.isArray(result['questions']) && result['questions'].length > 0) {
    const firstQ = result['questions'][0];
    if (firstQ && typeof firstQ === 'object') {
      const qObj = firstQ as Record<string, unknown>;
      if (qObj.question && !result['question']) {
        result['question'] = unquoteValue(qObj.question);
      }
      if (qObj.options && !result['options']) {
        result['options'] = unquoteValue(qObj.options);
      }
    }
  }

  // Dual-bridge: if question is present and questions array is missing, populate questions array
  if (result['question'] && !result['questions']) {
    result['questions'] = [
      {
        question: result['question'],
        options: result['options'] ?? [],
      },
    ];
  }

  return result;
}

function getTaskCompletion(content: string): { taskId: string; isError: boolean } | undefined {
  const taskId = /sender=([0-9a-f-]{36}\/task-\d+)/i.exec(content)?.[1];
  const outcome = /(?:finished|canceled|cancelled|failed) with result/i.exec(content)?.[0];
  if (!taskId || !outcome) return undefined;
  const exit = /exited with code (-?\d+)/i.exec(content);
  return {
    taskId,
    isError: /canceled|cancelled|failed/i.test(outcome) || (exit !== null && Number(exit[1]) !== 0),
  };
}

function extractSystemContent(content: string): string {
  const payload = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>\s*)?$/.exec(content)?.[1];
  return (payload ?? content).trim();
}

// ── Types for Parsing ────────────────────────────────────────────────────────

export interface AntigravityToolCall {
  name: string;
  args?: Record<string, unknown> | string;
}

export interface AntigravityStep {
  step_index?: number;
  source?: string;
  type: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: AntigravityToolCall[];
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  truncated_fields?: string[];
  [key: string]: unknown;
}

export interface HistoryRecord {
  conversationId?: string;
  workspace?: string;
  timestamp?: number;
  display?: string;
  type?: string;
}

interface HistorySessionInfo {
  firstPrompt?: string;
  lastPrompt?: string;
  latestTs?: number;
  workspace?: string;
}

// ── Session Discovery Helpers ────────────────────────────────────────────────

async function loadHistoryIndex(historyPath: string): Promise<Map<string, HistorySessionInfo>> {
  const map = new Map<string, HistorySessionInfo>();
  if (!fs.existsSync(historyPath)) return map;

  return new Promise((resolve) => {
    const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const item: HistoryRecord = JSON.parse(trimmed);
        if (item && typeof item === 'object' && typeof item.conversationId === 'string' && item.conversationId.length > 0) {
          const convId = item.conversationId;
          const ts = typeof item.timestamp === 'number' ? item.timestamp : undefined;
          const workspace = typeof item.workspace === 'string' ? item.workspace : undefined;
          const display = typeof item.display === 'string' ? item.display : undefined;

          if (!map.has(convId)) {
            map.set(convId, {
              firstPrompt: display,
              lastPrompt: display,
              latestTs: ts,
              workspace,
            });
          } else {
            const current = map.get(convId)!;
            if (ts !== undefined && (current.latestTs === undefined || ts > current.latestTs)) {
              current.latestTs = ts;
              if (display) current.lastPrompt = display;
            }
            if (workspace) {
              current.workspace = workspace;
            }
          }
        }
      } catch {
        // skip invalid jsonl lines
      }
    });

    rl.on('close', () => resolve(map));
    rl.on('error', () => resolve(map));
  });
}

interface HeadScanResult {
  summary?: string;
  cwd?: string;
  sawConversation: boolean;
}

async function scanTranscriptHead(filePath: string, maxLines = 30): Promise<HeadScanResult> {
  return new Promise((resolve) => {
    let summary: string | undefined;
    let systemSummary: string | undefined;
    let cwd: string | undefined;
    let sawConversation = false;

    if (!fs.existsSync(filePath)) {
      return resolve({ summary, cwd, sawConversation });
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;

    rl.on('line', (line) => {
      count++;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const step: AntigravityStep = JSON.parse(trimmed);
        if (!step || typeof step !== 'object') return;

        const isMission = step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string' &&
          step.content.trim().length > 0 && !getTaskCompletion(step.content);
        if (!sawConversation && (step.type === 'USER_INPUT' || step.type === 'USER_MESSAGE' ||
          step.type === 'PLANNER_RESPONSE' || step.type === 'ASSISTANT_STEP' || isMission)) {
          sawConversation = true;
        }

        if (!summary && (step.type === 'USER_INPUT' || step.type === 'USER_MESSAGE') && typeof step.content === 'string') {
          summary = cleanAntigravityPrompt(step.content);
        } else if (!systemSummary && isMission) {
          systemSummary = cleanAntigravityPrompt(step.content);
        }

        if (!cwd && step.tool_calls && Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            if (!tc.args) continue;
            const argsObj = typeof tc.args === 'string' ? normalizeToolArgs(tc.args) : tc.args;
            const directCwd = extractCwdValue(argsObj['Cwd'] || argsObj['cwd']);
            if (directCwd) {
              cwd = directCwd;
              break;
            }
            const absPath = extractCwdValue(argsObj['AbsolutePath'] || argsObj['TargetFile']);
            if (absPath && path.isAbsolute(absPath)) {
              cwd = path.dirname(absPath);
              break;
            }
          }
        }

        // If the head has only metadata, continue until conversation evidence or EOF.
        if (sawConversation && ((summary && cwd) || count >= maxLines)) {
          rl.close();
          stream.destroy();
        }
      } catch {
        // skip corrupted lines
      }
    });

    rl.on('close', () => resolve({ summary: summary ?? systemSummary, cwd, sawConversation }));
    rl.on('error', () => resolve({ summary: summary ?? systemSummary, cwd, sawConversation }));
  });
}

// ── Session Discovery ────────────────────────────────────────────────────────

export async function findAntigravitySessions(): Promise<SessionListEntry[]> {
  const dataDir = getAntigravityDataDir();
  const brainDir = path.join(dataDir, 'brain');

  if (!fs.existsSync(brainDir)) {
    return [];
  }

  let sessionDirs: string[];
  try {
    sessionDirs = fs.readdirSync(brainDir);
  } catch {
    return [];
  }

  const historyIndex = await loadHistoryIndex(path.join(dataDir, 'history.jsonl'));
  const entries: SessionListEntry[] = [];

  for (const convId of sessionDirs) {
    const transcriptCanonical = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    const transcriptFull = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');

    let transcriptPath = transcriptFull;
    let stat: fs.Stats;

    try {
      if (fs.existsSync(transcriptFull)) {
        stat = fs.statSync(transcriptFull);
      } else if (fs.existsSync(transcriptCanonical)) {
        transcriptPath = transcriptCanonical;
        stat = fs.statSync(transcriptCanonical);
      } else {
        continue; // Empty directory or non-session folder
      }
    } catch {
      continue;
    }

    const historyInfo = historyIndex.get(convId);
    let cwd = historyInfo?.workspace;
    let summary = cleanAntigravityPrompt(historyInfo?.lastPrompt || historyInfo?.firstPrompt);
    let sawConversation = false;

    // Use latest interaction timestamp
    let updatedAt = stat.mtime;
    if (historyInfo?.latestTs) {
      const historyDate = new Date(historyInfo.latestTs);
      if (historyDate.getTime() > updatedAt.getTime()) {
        updatedAt = historyDate;
      }
    }

    // History metadata alone does not prove the transcript contains a conversation.
    const scanResult = await scanTranscriptHead(transcriptPath, 30);
    if (!cwd && scanResult.cwd) cwd = scanResult.cwd;
    if (!summary && scanResult.summary) summary = scanResult.summary;
    sawConversation = scanResult.sawConversation;

    entries.push({
      id: convId,
      source: 'antigravity',
      cwd: cwd ? path.resolve(cwd) : '',
      updatedAt,
      summary: summary || undefined,
      filePath: transcriptPath,
      isEmpty: !sawConversation,
    });
  }

  // Sort descending by most recent activity
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return entries;
}

// ── Session Parsing ──────────────────────────────────────────────────────────

export async function parseAntigravitySession(filePath: string): Promise<NormalizedSession> {
  let transcriptPath = filePath;
  let conversationId = '';

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const canonical = path.join(filePath, '.system_generated', 'logs', 'transcript.jsonl');
    const full = path.join(filePath, '.system_generated', 'logs', 'transcript_full.jsonl');
    transcriptPath = fs.existsSync(full) ? full : canonical;
    conversationId = path.basename(filePath);
  } else {
    transcriptPath = filePath;
    const match = filePath.match(/brain[/\\]([^/\\]+)/);
    conversationId = match ? match[1] : path.basename(filePath, path.extname(filePath));
  }

  const steps = await readJsonlFile<AntigravityStep>(transcriptPath);
  let fileBytes = 0;
  let rawLineCount = steps.length;
  try {
    const st = await getFileStats(transcriptPath);
    fileBytes = st.bytes;
    rawLineCount = st.lines;
  } catch {
    // fallback
  }

  // Locate base directory
  let baseDir = getAntigravityDataDir();
  if (transcriptPath.includes('brain')) {
    const brainIdx = transcriptPath.lastIndexOf('brain');
    const candidateBase = transcriptPath.slice(0, brainIdx).replace(/[/\\]$/, '');
    if (candidateBase && fs.existsSync(candidateBase)) {
      baseDir = candidateBase;
    }
  }

  // Load history entry if available
  const historyPath = path.join(baseDir, 'history.jsonl');
  let historyCwd: string | undefined;
  let historyTimestamp: Date | undefined;

  if (fs.existsSync(historyPath)) {
    const historyLines = await readJsonlFile<HistoryRecord>(historyPath);
    const matched = historyLines.find((h) => h.conversationId === conversationId);
    if (matched) {
      if (matched.workspace) historyCwd = matched.workspace;
      if (matched.timestamp) historyTimestamp = parseDefensiveTimestamp(matched.timestamp);
    }
  }

  // Settings model resolution (session-specific first, then baseDir)
  let defaultModel: string | undefined;
  const candidateSettingsPaths = [
    path.join(path.dirname(transcriptPath), '..', '..', 'settings.json'),
    path.join(baseDir, 'brain', conversationId, 'settings.json'),
    path.join(baseDir, 'settings.json'),
  ];
  for (const sp of candidateSettingsPaths) {
    if (fs.existsSync(sp)) {
      try {
        const settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
        if (settings?.model && typeof settings.model === 'string') {
          defaultModel = settings.model;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  const exploded: ExplodedMessage[] = [];
  const pendingToolCalls: Array<{ id: string; name: string }> = [];
  const backgroundTasks = new Map<string, { id: string; name: string }>();
  const toolCounts = new Map<string, { count: number; errors: number }>();
  const filesModifiedSet = new Set<string>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let hasTokens = false;
  let extractedModel: string | undefined = defaultModel;
  let fallbackCwd: string | undefined;
  const hasUserInput = steps.some((step) => step?.type === 'USER_INPUT' || step?.type === 'USER_MESSAGE');
  let sawMissionPrompt = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const ts = parseDefensiveTimestamp(step.created_at, historyTimestamp || new Date());
    const lineIndex = typeof step.step_index === 'number' ? step.step_index : i;

    switch (step.type) {
      case 'USER_INPUT':
      case 'USER_MESSAGE': {
        pendingToolCalls.length = 0; // Turn isolation: clear abandoned pending tool calls
        const rawContent = step.content || '';
        const userPrompt = extractUserPrompt(rawContent);

        // Check for model change in settings
        const modelMatch =
          rawContent.match(/setting `Model Selection` from .*? to (.+?)\.(?:\s+No need|\s+[A-Z]|\n|$)/i) ||
          rawContent.match(/setting `Model Selection` from .*? to ([^\n<]+)/i);
        if (modelMatch && modelMatch[1]) {
          extractedModel = modelMatch[1].replace(/\.$/, '').trim();
        }

        exploded.push({
          role: 'user',
          content: userPrompt,
          blocks: [{ type: 'text', text: userPrompt }],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'PLANNER_RESPONSE':
      case 'ASSISTANT_STEP': {
        if (typeof step.input_tokens === 'number') {
          inputTokens += step.input_tokens;
          hasTokens = true;
        }
        if (typeof step.output_tokens === 'number') {
          outputTokens += step.output_tokens;
          hasTokens = true;
        }
        if (typeof step.cache_read_tokens === 'number') {
          cacheReadTokens += step.cache_read_tokens;
          hasTokens = true;
        }

        const assistantBlocks: ContentBlock[] = [];
        let textContent = '';

        if (step.thinking && step.thinking.trim()) {
          assistantBlocks.push({ type: 'thinking', text: step.thinking.trim() });
        }
        if (step.content && step.content.trim()) {
          assistantBlocks.push({ type: 'text', text: step.content.trim() });
          textContent = step.content.trim();
        }

        if (assistantBlocks.length > 0) {
          let displayContent = textContent;
          if (!displayContent) {
            displayContent = '[thinking] ' + (step.thinking || '').trim().slice(0, 200);
          }
          exploded.push({
            role: 'assistant',
            content: displayContent,
            blocks: assistantBlocks,
            timestamp: ts,
            rawLineIndex: lineIndex,
          });
        }

        if (Array.isArray(step.tool_calls)) {
          step.tool_calls.forEach((tc, tcIdx) => {
            const toolName = tc.name || 'unknown';
            const normalizedArgs = normalizeToolArgs(tc.args);
            const callId = `agy-${lineIndex}-${tcIdx}-${toolName}`;

            if (!fallbackCwd && typeof normalizedArgs['Cwd'] === 'string') {
              fallbackCwd = normalizedArgs['Cwd'];
            }

            if (FILE_MODIFYING_TOOLS.has(toolName)) {
              const target =
                normalizedArgs['TargetFile'] ||
                normalizedArgs['file_path'] ||
                normalizedArgs['path'];
              if (typeof target === 'string' && target.trim()) {
                filesModifiedSet.add(target.trim());
              }
            }

            if (toolName === 'apply_patch') {
              const patchStr = typeof normalizedArgs['patch'] === 'string'
                ? normalizedArgs['patch']
                : typeof normalizedArgs['input'] === 'string'
                ? normalizedArgs['input']
                : '';
              if (patchStr) {
                const patchHeader = /\*{3}\s+(?:Add|Update|Delete)\s+File:?\s*([^\r\n]+)/gi;
                let pm: RegExpExecArray | null;
                while ((pm = patchHeader.exec(patchStr)) !== null) {
                  const clean = pm[1].trim().replace(/^['"]|['"]$/g, '');
                  if (clean) filesModifiedSet.add(clean);
                }
              }
            }

            const tcStat = toolCounts.get(toolName) || { count: 0, errors: 0 };
            tcStat.count++;
            toolCounts.set(toolName, tcStat);

            pendingToolCalls.push({ id: callId, name: toolName });

            const toolBlock: ContentBlock = {
              type: 'tool_use',
              id: callId,
              name: toolName,
              input: normalizedArgs,
            };

            exploded.push({
              role: 'tool_use',
              content: `Tool: ${toolName}`,
              blocks: [toolBlock],
              timestamp: ts,
              rawLineIndex: lineIndex,
            });
          });
        }
        break;
      }

      case 'GENERIC':
      case 'TOOL_STEP': {
        const pending = pendingToolCalls.shift();
        const callId = pending?.id || `agy-generic-${lineIndex}`;
        const toolName = pending?.name || 'unknown';
        const content = step.content || '';
        if (pending && step.status === 'RUNNING') {
          const taskId = /task id:?\s*"?([0-9a-f-]{36}\/task-\d+)/i.exec(content)?.[1];
          if (taskId) backgroundTasks.set(taskId, pending);
        }

        const isError =
          step.status === 'ERROR' ||
          step.status === 'INVALID' ||
          Boolean(step.error) ||
          /exited with code [1-9]/i.test(content) ||
          content.startsWith('Error:');

        if (isError && toolName !== 'unknown') {
          const tcStat = toolCounts.get(toolName);
          if (tcStat) tcStat.errors++;
        }

        const resultBlock: ContentBlock = {
          type: 'tool_result',
          toolUseId: callId,
          content,
          isError,
        };

        exploded.push({
          role: 'tool_result',
          content,
          blocks: [resultBlock],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'CHECKPOINT': {
        const content = step.content || step.error || `[${step.type}]`;
        const isCompaction = content.startsWith('# Resuming from a compaction');
        if (isCompaction) {
          exploded.push({
            role: 'system',
            content,
            blocks: [{ type: 'text', text: content }],
            timestamp: ts,
            rawLineIndex: lineIndex,
          });
        } else {
          exploded.push({
            role: 'system',
            content,
            blocks: [{ type: 'text', text: content }],
            timestamp: ts,
            rawLineIndex: lineIndex,
          });
        }
        break;
      }

      case 'SYSTEM_MESSAGE':
      case 'ERROR_MESSAGE':
      case 'ERROR':
      case 'TASK_NOTIFICATION': {
        const content = step.content || step.error || `[${step.type}]`;
        const completion = step.type === 'SYSTEM_MESSAGE' ? getTaskCompletion(content) : undefined;
        const call = completion && backgroundTasks.get(completion.taskId);
        if (completion && call) {
          const result = extractSystemContent(content);
          exploded.push({
            role: 'tool_result',
            content: result,
            blocks: [{ type: 'tool_result', toolUseId: call.id, content: result, isError: completion.isError }],
            timestamp: ts,
            rawLineIndex: lineIndex,
          });
          if (completion.isError) {
            const tcStat = toolCounts.get(call.name);
            if (tcStat) tcStat.errors++;
          }
        }
        const isMission = step.type === 'SYSTEM_MESSAGE' && !completion && !hasUserInput && !sawMissionPrompt;
        if (isMission) sawMissionPrompt = true;
        const messageContent = isMission ? extractSystemContent(content) : content;
        exploded.push({
          role: isMission ? 'user' : 'system',
          content: messageContent,
          blocks: [{ type: 'text', text: messageContent }],
          timestamp: ts,
          rawLineIndex: lineIndex,
        });
        break;
      }

      default:
        break;
    }
  }

  const messages: NormalizedMessage[] = indexMessages(exploded);

  // Compute stats
  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};

  for (const msg of messages) {
    switch (msg.role) {
      case 'user': byRole.user++; break;
      case 'assistant': byRole.assistant++; break;
      case 'system': byRole.system++; break;
      case 'tool_use': byRole.toolUse++; break;
      case 'tool_result': byRole.toolResult++; break;
    }
    for (const b of msg.blocks) {
      byBlockType[b.type] = (byBlockType[b.type] || 0) + 1;
    }
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, stat]) => ({ name, count: stat.count, errors: stat.errors }))
    .sort((a, b) => b.count - a.count);

  let durationMs: number | undefined;
  if (messages.length >= 2) {
    const startMs = messages[0].timestamp.getTime();
    const endMs = messages[messages.length - 1].timestamp.getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      durationMs = endMs - startMs;
    }
  }

  const stats: SessionStats = {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    tokenUsage: hasTokens
      ? {
          input: inputTokens,
          output: outputTokens,
          ...(cacheReadTokens > 0 ? { cacheRead: cacheReadTokens } : {}),
        }
      : undefined,
    toolFrequency,
    filesModified: Array.from(filesModifiedSet).sort(),
    durationMs,
  };

  const cwd = historyCwd || fallbackCwd || process.cwd();
  const fallbackNow = new Date();
  const validHistory = historyTimestamp && !isNaN(historyTimestamp.getTime()) ? historyTimestamp : undefined;
  const createdAt = messages[0]?.timestamp && !isNaN(messages[0].timestamp.getTime())
    ? messages[0].timestamp
    : (validHistory || fallbackNow);
  const updatedAt = messages[messages.length - 1]?.timestamp && !isNaN(messages[messages.length - 1].timestamp.getTime())
    ? messages[messages.length - 1].timestamp
    : createdAt;

  const metadata: SessionMetadata = {
    cwd,
    model: extractedModel || 'Gemini',
    createdAt,
    updatedAt,
    fileBytes,
    rawLineCount,
  };

  const session: NormalizedSession = {
    id: conversationId,
    source: 'antigravity',
    filePath: transcriptPath,
    metadata,
    messages,
    stats,
  };
  return session;
}

// ── Registry Registration ────────────────────────────────────────────────────

registerSource({
  name: 'antigravity',
  label: 'Antigravity',
  color: '#4285F4',
  getDataDir: getAntigravityDataDir,
  find: findAntigravitySessions,
  parse: parseAntigravitySession,
});
