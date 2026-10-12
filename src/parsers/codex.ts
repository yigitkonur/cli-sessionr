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

import {
  readJsonlFile,
  scanJsonlHead,
  getFileStats,
  truncate,
  findFiles,
} from './common.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const SESSION_SUBDIR = 'sessions';
const ARCHIVED_SESSION_SUBDIR = 'archived_sessions';
const MAX_TOOL_RESULT_PREVIEW = 500;

// ── Internal raw-usage type ─────────────────────────────────────────────────

interface RawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface TokenDelta {
  inputTokens: number;
  cacheRead: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Codex raw event shapes (loosely typed for resilience) ───────────────────

interface CodexEvent {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown>;
}

// ── Codex home / directory helpers ──────────────────────────────────────────

function getCodexHome(): string {
  const env = process.env['CODEX_HOME'];
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.codex');
}

function getSessionsDir(): string {
  return path.join(getCodexHome(), SESSION_SUBDIR);
}

function getArchivedSessionsDir(): string {
  return path.join(getCodexHome(), ARCHIVED_SESSION_SUBDIR);
}

// ── Filename helpers ────────────────────────────────────────────────────────

const ROLLOUT_RE = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/;

function extractIdFromFilename(filePath: string): string {
  const match = path.basename(filePath).match(ROLLOUT_RE);
  if (match) return match[7];
  return path.basename(filePath, '.jsonl');
}

// ── Content extraction (ported from agentlytics) ────────────────────────────

function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item: Record<string, unknown>) =>
        item && item.type === 'input_text' && typeof item.text === 'string',
    )
    .map((item: Record<string, unknown>) => (item.text as string).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item: Record<string, unknown>) =>
        item && item.type === 'output_text' && typeof item.text === 'string',
    )
    .map((item: Record<string, unknown>) => (item.text as string).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ── Reasoning summary (ported from agentlytics) ─────────────────────────────

function extractReasoningSummary(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (!Array.isArray(summary)) return '';
  return summary
    .filter(
      (item: Record<string, unknown>) =>
        item && typeof item.text === 'string' && (item.text as string).trim(),
    )
    .map((item: Record<string, unknown>) => (item.text as string).trim())
    .join('\n')
    .trim();
}

// ── Bootstrap / skip detection (ported from agentlytics + our extras) ───────

function isBootstrapMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('<user_instructions>') ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<permissions') ||
    trimmed.startsWith('# AGENTS.md')
  );
}

// ── Model extraction (ported from agentlytics — recursive) ──────────────────

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractModel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const direct = asNonEmptyString(obj.model) || asNonEmptyString(obj.model_name);
  if (direct) return direct;

  if (obj.info && typeof obj.info === 'object') {
    const infoModel = extractModel(obj.info);
    if (infoModel) return infoModel;
  }

  if (obj.metadata && typeof obj.metadata === 'object') {
    const metadataModel = extractModel(obj.metadata);
    if (metadataModel) return metadataModel;
  }

  return null;
}

// ── Token delta pipeline (ported from agentlytics) ──────────────────────────

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeRawUsage(value: unknown): RawUsage | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const input = ensureNumber(obj.input_tokens);
  const cached = ensureNumber(
    obj.cached_input_tokens != null ? obj.cached_input_tokens : obj.cache_read_input_tokens,
  );
  const output = ensureNumber(obj.output_tokens);
  const total = ensureNumber(obj.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: total > 0 ? total : input + output,
  };
}

function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
  return {
    input_tokens: Math.max(current.input_tokens - (previous ? previous.input_tokens : 0), 0),
    cached_input_tokens: Math.max(
      current.cached_input_tokens - (previous ? previous.cached_input_tokens : 0),
      0,
    ),
    output_tokens: Math.max(current.output_tokens - (previous ? previous.output_tokens : 0), 0),
    total_tokens: Math.max(current.total_tokens - (previous ? previous.total_tokens : 0), 0),
  };
}

function convertToDelta(raw: RawUsage): TokenDelta {
  const cacheRead = Math.min(raw.cached_input_tokens, raw.input_tokens);
  const billableInput = Math.max(raw.input_tokens - cacheRead, 0);
  return {
    inputTokens: billableInput,
    cacheRead,
    outputTokens: raw.output_tokens,
    totalTokens: raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens,
  };
}

// ── Tool argument parsing (ported from agentlytics) ─────────────────────────

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  const parsed = safeParseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function truncateSingleLine(text: string, maxLen: number): string {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.substring(0, maxLen) + '\u2026' : oneLine;
}

export interface UnrolledExec {
  toolName: string;
  args: Record<string, unknown>;
  patchContent?: string;
}

function unescapeJsString(raw: string): string {
  let output = '';
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { output += raw[i]; continue; }
    const next = raw[++i];
    if (next === '\n' || next === ' ' || next === ' ') continue;
    if (next === '\r') { if (raw[i + 1] === '\n') i++; continue; }
    if (next === 'x' || next === 'u') {
      const braced = next === 'u' && raw[i + 1] === '{';
      const end = braced ? raw.indexOf('}', i + 2) : i + (next === 'x' ? 2 : 4) + 1;
      const hex = raw.slice(i + (braced ? 2 : 1), end);
      if (/^[\da-f]+$/i.test(hex) && (braced ? hex.length <= 6 : hex.length === (next === 'x' ? 2 : 4))) {
        const value = parseInt(hex, 16);
        if (value <= 0x10ffff) {
          output += String.fromCodePoint(value);
          i = braced ? end : end - 1;
          continue;
        }
      }
    }
    // Quotes, backticks, backslashes and identity escapes all decode here.
    output += escapes[next] ?? next ?? '\\';
  }
  return output;
}

// Keep offsets, but hide strings/templates and comments from invocation matching.
// Transcript JavaScript is data: it must never be evaluated.
function maskJsNonCode(source: string): string {
  return source.replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (literal) => ' '.repeat(literal.length));
}

// Slice a call's arguments without letting later calls or unrelated objects leak in.
function invocationInput(source: string, code: string, start: number): string {
  let depth = 1;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

function extractPatchString(rawInput: string, code: string, callInput: string): string | undefined {
  const argument = callInput.replace(/^\s*\{\s*(?:patch|"patch"|'patch')\s*:\s*/, '').trimStart();
  const literal = /^(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|`((?:[^`\\]|\\[\s\S])*)`)/;
  const decode = (match: RegExpMatchArray): string =>
    unescapeJsString(match[1] ?? match[2] ?? match[3] ?? '');
  const direct = argument.match(literal);
  if (direct) return decode(direct);
  const variable = /^([a-zA-Z_$][\w$]*)\s*(?:[,}]|$)/.exec(argument);
  if (!variable) return undefined;
  const escapedName = variable[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definition = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=`).exec(code);
  if (!definition) return undefined;
  const value = rawInput.slice(definition.index + definition[0].length).trimStart().match(literal);
  return value ? decode(value) : undefined;
}

// Recover only literal object properties; dynamic expressions remain in raw input.
function parseStaticToolArgs(input: string): Record<string, unknown> {
  const parsed = safeParseJson(input.trim());
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  const source = input.trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return {};
  const code = maskJsNonCode(source);
  const properties: [string, unknown][] = [];
  let start = 1;
  let depth = 0;
  for (let i = 1; i < source.length; i++) {
    if (depth === 0 && (code[i] === ',' || i === source.length - 1)) {
      const property = source.slice(start, i).trim().match(/^(?:([\w$]+)|"([^"\\]+)"|'([^'\\]+)')\s*:\s*([\s\S]+)$/);
      if (property) {
        const key = property[1] ?? property[2] ?? property[3];
        const value = property[4].trim();
        const literal = /^(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|`((?:[^`\\]|\\[\s\S])*)`)$/s.exec(value);
        if (literal) properties.push([key, unescapeJsString(literal[1] ?? literal[2] ?? literal[3])]);
        else if (/^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)$/i.test(value)) properties.push([key, JSON.parse(value)]);
      }
      start = i + 1;
    } else if ('{[('.includes(code[i])) depth++;
    else if ('}])'.includes(code[i])) depth--;
  }
  return Object.fromEntries(properties);
}

export function unrollCodexExec(rawInput: string): UnrolledExec {
  const trimmed = rawInput.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (parsed.tool === 'exec_command' || parsed.command || parsed.cmd) {
          const isCommand = (value: unknown): value is string | string[] =>
            typeof value === 'string' || Array.isArray(value) && value.every((part) => typeof part === 'string');
          const cmd = isCommand(parsed.command) ? parsed.command : isCommand(parsed.cmd) ? parsed.cmd : undefined;
          return {
            toolName: 'exec_command',
            args: {
              ...(cmd !== undefined ? { cmd, command: cmd } : {}),
              ...(parsed.workdir ? { workdir: parsed.workdir } : {}),
              raw: rawInput,
            },
          };
        }
        if (parsed.tool === 'apply_patch' || parsed.patch) {
          const patch =
            typeof parsed.patch === 'string'
              ? parsed.patch
              : typeof parsed.input === 'string'
                ? parsed.input
                : '';
          return {
            toolName: 'apply_patch',
            args: {
              patch,
              input: patch,
              raw: rawInput,
            },
            patchContent: patch,
          };
        }
      }
    } catch {
      // Not JSON, continue to JS code analysis
    }
  }

  const code = maskJsNonCode(rawInput);
  const invocations = [...code.matchAll(/\b(?:tools\.(\w+)|(exec_command|apply_patch))\s*\(/g)]
    .map((match) => ({ name: match[1] ?? match[2], start: match.index + match[0].length }));
  const patches = invocations.filter((call) => call.name === 'apply_patch')
    .map((call) => extractPatchString(rawInput, code, invocationInput(rawInput, code, call.start)))
    .filter((patch): patch is string => patch !== undefined);
  const patchContent = patches.length ? patches.join('\n') : undefined;

  // Prefer a command for the summary, but preserve patches from mixed wrappers.
  const commandCall = invocations.find((call) => call.name === 'exec_command');
  if (commandCall) {
    const callInput = invocationInput(rawInput, code, commandCall.start);
    const cmdMatch =
      callInput.match(
        /(?:\b(?:cmd|command)|"(?:cmd|command)"|'(?:cmd|command)')\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/s,
      ) ??
      callInput.match(
        /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/s,
      );
    let cmd: string | undefined;
    if (cmdMatch) {
      const rawMatch = cmdMatch[1] ?? cmdMatch[2] ?? cmdMatch[3] ?? '';
      cmd = unescapeJsString(rawMatch);
    }

    let workdir: string | undefined;
    const wdMatch = callInput.match(
      /workdir\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/s,
    );
    if (wdMatch) {
      const rawWd = wdMatch[1] ?? wdMatch[2] ?? wdMatch[3] ?? '';
      workdir = unescapeJsString(rawWd);
    }

    return {
      toolName: 'exec_command',
      args: {
        ...(cmd !== undefined ? { cmd } : {}),
        ...(workdir ? { workdir } : {}),
        raw: rawInput,
      },
      patchContent,
    };
  }

  if (invocations.some((call) => call.name === 'apply_patch')) {
    const patch = patchContent ?? rawInput;

    return {
      toolName: 'apply_patch',
      args: {
        patch,
        input: patch,
        raw: rawInput,
      },
      patchContent: patch,
    };
  }

  const innerCall = invocations[0];
  if (innerCall) {
    return {
      toolName: innerCall.name,
      args: { ...parseStaticToolArgs(invocationInput(rawInput, code, innerCall.start)), raw: rawInput },
      patchContent,
    };
  }

  // Fallback: generic exec
  return {
    toolName: 'exec',
    args: {
      input: rawInput,
      raw: rawInput,
    },
  };
}

function parseToolArgs(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type === 'function_call') {
    return parseJsonRecord(payload.arguments);
  }
  if (payload.type === 'custom_tool_call') {
    const raw = String(payload.input || '');
    return { input: truncateSingleLine(raw, 300) };
  }
  if (payload.type === 'web_search_call') {
    return parseJsonRecord(payload.arguments ?? payload.input ?? payload.query);
  }
  return {};
}

// ── Tool output preview (ported from agentlytics) ───────────────────────────

function previewToolOutput(output: unknown): string {
  if (output == null) return '';
  let value: unknown = output;
  if (typeof value === 'string') {
    const parsed = safeParseJson(value);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).output === 'string'
    ) {
      value = (parsed as Record<string, unknown>).output;
    }
    // else keep original string
  } else if (typeof value === 'object') {
    value = JSON.stringify(value);
  } else {
    value = String(value);
  }

  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return truncateSingleLine(trimmed, MAX_TOOL_RESULT_PREVIEW);
}

// ── Error detection (conservative) ──────────────────────────────────────────

function detectToolError(output: string): boolean {
  return output.startsWith('Error:') || output.startsWith('FAILED') ||
    output.startsWith('Script failed') ||
    [...output.matchAll(/^Process exited with code (-?\d+)\b/gm)].some((match) => Number(match[1]) !== 0);
}

export function parseToolOutputError(rawOutput: unknown): boolean {
  if (rawOutput == null) return false;
  if (Array.isArray(rawOutput)) {
    // A successful block must not hide a later failure.
    return rawOutput.some((item) => parseToolOutputError(item));
  }
  if (typeof rawOutput === 'string') {
    const trimmed = rawOutput.trim();
    const parsed = safeParseJson(trimmed);
    if (parsed && typeof parsed === 'object') return parseToolOutputError(parsed);
    return detectToolError(trimmed);
  }
  if (typeof rawOutput === 'object') {
    const obj = rawOutput as Record<string, unknown>;
    if (obj.type === 'error' || obj.is_error === true) return true;
    for (const key of ['exit_code', 'returncode', 'status']) {
      if (typeof obj[key] === 'number' && obj[key] !== 0) return true;
    }
    return parseToolOutputError(obj.metadata) || parseToolOutputError(obj.text) ||
      parseToolOutputError(obj.output);
  }
  return false;
}

// ── File extraction from apply_patch ────────────────────────────────────────

export function extractFilesFromPatch(input: string): string[] {
  if (!input || typeof input !== 'string') return [];
  const files = new Set<string>();
  const lines = input.split(/\r?\n/);
  let gitHeader = false;
  let inHunk = false;
  const addDiffPath = (raw: string) => {
    let file = raw.split('\t')[0].trim();
    if (file.startsWith('"') && file.endsWith('"')) {
      const decoded = safeParseJson(file);
      file = typeof decoded === 'string' ? decoded : file.slice(1, -1);
    }
    if (!file || file === '/dev/null') return;
    if (gitHeader) file = file.replace(/^[ab]\//, '');
    files.add(file);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const native = /^\*{3}\s+(?:Add|Update|Delete)\s+File:?\s+([^\r\n]+)$/i.exec(line);
    if (native) {
      // Native patch paths are literal, not git-side paths or diff sentinels.
      files.add(native[1].trim());
      gitHeader = false;
      inHunk = false;
    } else if (/^diff\s+--git\s+/.test(line)) {
      gitHeader = true;
      inHunk = false;
      const paths = line.replace(/^diff\s+--git\s+/, '').match(/"(?:[^"\\]|\\.)*"|\S+/g);
      if (paths?.length === 2) paths.forEach(addDiffPath);
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      // Unified-diff headers must be a pair before the hunk, never hunk text.
      addDiffPath(line.slice(4));
      addDiffPath(lines[++i].slice(4));
    }
  }
  return [...files];
}

// ── Tool-call / tool-output type guards ─────────────────────────────────────

function isToolCallType(type: string): boolean {
  return type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call';
}

function isToolOutputType(type: string): boolean {
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

// ── parseCodexSession ───────────────────────────────────────────────────────

export async function parseCodexSession(filePath: string): Promise<NormalizedSession> {
  const events = await readJsonlFile<CodexEvent>(filePath);
  const fileStats = await getFileStats(filePath);

  // ── 1. Extract metadata from session_meta + turn_context ──────────────

  let sessionId = extractIdFromFilename(filePath);
  let cwd = '';
  let gitBranch: string | undefined;
  let gitRepo: string | undefined;
  let currentModel: string | null = null;
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  for (const event of events) {
    if (event.timestamp) {
      const ts = new Date(event.timestamp);
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    if (event.type === 'session_meta' && event.payload) {
      const p = event.payload;
      if (typeof p.id === 'string' && p.id) sessionId = p.id;
      if (typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;
      const git = p.git as Record<string, unknown> | undefined;
      if (git) {
        if (typeof git.branch === 'string') gitBranch = git.branch;
        if (typeof git.repository_url === 'string') gitRepo = git.repository_url;
      }
    }

    // Extract model from turn_context and token_count events via recursive search
    if (event.type === 'turn_context' && event.payload) {
      const m = extractModel(event.payload);
      if (m) currentModel = m;
    }
    if (
      event.type === 'event_msg' &&
      event.payload &&
      (event.payload as Record<string, unknown>).type === 'token_count'
    ) {
      const info = (event.payload as Record<string, unknown>).info;
      const m = extractModel(info) || extractModel(event.payload);
      if (m) currentModel = m;
    }
  }

  const now = new Date();
  const metadata: SessionMetadata = {
    cwd,
    gitBranch,
    gitRepo,
    model: currentModel ?? undefined,
    createdAt: firstTimestamp ?? now,
    updatedAt: lastTimestamp ?? now,
    fileBytes: fileStats.bytes,
    rawLineCount: fileStats.lines,
  };

  // ── 2. Token delta accumulation (proper pipeline from agentlytics) ────

  let previousTotals: RawUsage | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;

  for (const event of events) {
    if (
      event.type === 'event_msg' &&
      event.payload &&
      (event.payload as Record<string, unknown>).type === 'token_count'
    ) {
      const info = ((event.payload as Record<string, unknown>).info ?? {}) as Record<
        string,
        unknown
      >;
      const lastUsage = normalizeRawUsage(info.last_token_usage);
      const totalUsage = normalizeRawUsage(info.total_token_usage);

      let rawUsage = lastUsage;
      if (!rawUsage && totalUsage) rawUsage = subtractRawUsage(totalUsage, previousTotals);
      if (totalUsage) previousTotals = totalUsage;
      if (!rawUsage) continue;

      const delta = convertToDelta(rawUsage);
      if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.cacheRead === 0) continue;

      totalInputTokens += delta.inputTokens;
      totalOutputTokens += delta.outputTokens;
      totalCacheRead += delta.cacheRead;
    }
  }

  // ── 3. Build exploded messages ────────────────────────────────────────

  const messages: NormalizedMessage[] = [];
  const toolCallMap = new Map<string, string>(); // call_id -> tool name
  const filesModified: string[] = [];
  const toolCounts = new Map<string, { count: number; errors: number }>();

  // Determine whether response_item events exist (newer format preferred)
  const hasResponseItems = events.some((e) => e.type === 'response_item');

  function addToolCount(name: string, isError: boolean): void {
    const existing = toolCounts.get(name) ?? { count: 0, errors: 0 };
    existing.count++;
    if (isError) existing.errors++;
    toolCounts.set(name, existing);
  }

  function pushMessage(msg: Omit<NormalizedMessage, 'index'>): void {
    messages.push({ ...msg, index: messages.length + 1 });
  }

  for (let lineIdx = 0; lineIdx < events.length; lineIdx++) {
    const event = events[lineIdx];
    const ts = event.timestamp ? new Date(event.timestamp) : (lastTimestamp ?? now);

    // ── response_item events ──────────────────────────────────────────

    if (event.type === 'response_item' && event.payload) {
      const p = event.payload;
      const pType = p.type as string;
      const pRole = p.role as string | undefined;

      // Skip developer role (system instructions injected by the CLI)
      if (pRole === 'developer') continue;

      // ── message ─────────────────────────────────────────────────────

      if (pType === 'message') {
        if (pRole === 'user') {
          const text = extractUserText(p.content);
          if (!text || isBootstrapMessage(text)) continue;
          const blocks: ContentBlock[] = [{ type: 'text', text }];
          pushMessage({ role: 'user', timestamp: ts, content: text, blocks, rawLineIndex: lineIdx });
        } else if (pRole === 'system') {
          const text = extractAssistantText(p.content);
          if (!text) continue;
          const blocks: ContentBlock[] = [{ type: 'text', text }];
          pushMessage({ role: 'system', timestamp: ts, content: text, blocks, rawLineIndex: lineIdx });
        } else {
          // assistant or unspecified role
          const text = extractAssistantText(p.content);
          if (!text) continue;
          const blocks: ContentBlock[] = [{ type: 'text', text }];
          pushMessage({
            role: 'assistant',
            timestamp: ts,
            content: text,
            blocks,
            rawLineIndex: lineIdx,
          });
        }
        continue;
      }

      // ── reasoning ───────────────────────────────────────────────────

      if (pType === 'reasoning') {
        const summaryText = extractReasoningSummary(p);
        if (!summaryText) continue;
        const blocks: ContentBlock[] = [{ type: 'thinking', text: summaryText }];
        pushMessage({
          role: 'assistant',
          timestamp: ts,
          content: summaryText,
          blocks,
          rawLineIndex: lineIdx,
        });
        continue;
      }

      // ── tool calls (function_call, custom_tool_call, web_search_call) ─

      if (isToolCallType(pType)) {
        let toolName =
          typeof p.name === 'string' && p.name
            ? p.name
            : pType === 'web_search_call'
              ? 'web_search'
              : 'unknown';
        let args = parseToolArgs(p);
        let patchToExtract: string | undefined;

        if (pType === 'custom_tool_call') {
          const rawInput = String(p.input || '');
          if (toolName === 'exec') {
            const unrolled = unrollCodexExec(rawInput);
            toolName = unrolled.toolName;
            args = unrolled.args;
            patchToExtract = unrolled.patchContent;
          }
        }

        const callId =
          (typeof p.call_id === 'string' && p.call_id) ||
          (typeof p.id === 'string' && p.id) ||
          `call_${lineIdx}`;

        toolCallMap.set(callId, toolName);
        addToolCount(toolName, false);

        // Extract files modified from apply_patch
        if (toolName === 'apply_patch' || patchToExtract !== undefined) {
          const inputStr =
            patchToExtract ||
            (pType === 'custom_tool_call'
              ? String(p.input || '')
              : typeof (args as Record<string, unknown>).patch === 'string'
                ? (args as Record<string, unknown>).patch as string
                : typeof (args as Record<string, unknown>).input === 'string'
                  ? (args as Record<string, unknown>).input as string
                  : '');
          if (inputStr) {
            for (const f of extractFilesFromPatch(inputStr)) {
              if (!filesModified.includes(f)) filesModified.push(f);
            }
          }
        }

        const block: ContentBlock = { type: 'tool_use', id: callId, name: toolName, input: args };
        pushMessage({
          role: 'tool_use',
          timestamp: ts,
          content: `Tool: ${toolName}`,
          blocks: [block],
          rawLineIndex: lineIdx,
        });
        continue;
      }

      // ── tool outputs (function_call_output, custom_tool_call_output) ─

      if (isToolOutputType(pType)) {
        const callId =
          (typeof p.call_id === 'string' && p.call_id) || `call_${lineIdx}`;

        const rawOutput = p.output;
        const outputStr = previewToolOutput(rawOutput);
        // For tool_result content, keep the full string when it's already a string
        const fullOutput =
          typeof rawOutput === 'string'
            ? rawOutput
            : rawOutput != null
              ? JSON.stringify(rawOutput)
              : '';

        const isError = parseToolOutputError(rawOutput);
        const toolName = toolCallMap.get(callId);

        if (toolName && isError) {
          const existing = toolCounts.get(toolName);
          if (existing) existing.errors++;
        }

        const block: ContentBlock = {
          type: 'tool_result',
          toolUseId: callId,
          content: fullOutput,
          isError,
        };
        pushMessage({
          role: 'tool_result',
          timestamp: ts,
          content: outputStr || fullOutput || (isError ? '[error]' : '[empty]'),
          blocks: [block],
          rawLineIndex: lineIdx,
        });
        continue;
      }

      // Other response_item types silently ignored
      continue;
    }

    // ── event_msg fallback (only when no response_items exist) ─────────

    if (event.type === 'event_msg' && !hasResponseItems && event.payload) {
      const p = event.payload;
      const pType = p.type as string;

      if (pType === 'token_count' || pType === 'agent_reasoning') continue;

      const text = typeof p.message === 'string' ? p.message : '';

      if (pType === 'user_message') {
        if (!text || isBootstrapMessage(text)) continue;
        pushMessage({
          role: 'user',
          timestamp: ts,
          content: text,
          blocks: [{ type: 'text', text }],
          rawLineIndex: lineIdx,
        });
      } else if (pType === 'agent_message' || pType === 'assistant_message') {
        if (!text) continue;
        pushMessage({
          role: 'assistant',
          timestamp: ts,
          content: text,
          blocks: [{ type: 'text', text }],
          rawLineIndex: lineIdx,
        });
      }
    }
  }

  // ── 4. Compute stats ──────────────────────────────────────────────────

  const byRole = { user: 0, assistant: 0, system: 0, toolUse: 0, toolResult: 0 };
  const byBlockType: Record<string, number> = {};

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
    }
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  const hasTokens = totalInputTokens > 0 || totalOutputTokens > 0;
  const tokenUsage = hasTokens
    ? {
        input: totalInputTokens,
        output: totalOutputTokens,
        ...(totalCacheRead > 0 ? { cacheRead: totalCacheRead } : {}),
      }
    : undefined;

  let durationMs: number | undefined;
  if (firstTimestamp && lastTimestamp) {
    const diff = lastTimestamp.getTime() - firstTimestamp.getTime();
    if (diff > 0) durationMs = diff;
  }

  const stats: SessionStats = {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    tokenUsage,
    toolFrequency,
    filesModified,
    durationMs,
  };

  return {
    id: sessionId,
    source: 'codex',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── findCodexSessions ───────────────────────────────────────────────────────

export async function findCodexSessions(): Promise<SessionListEntry[]> {
  const dirs = [getSessionsDir(), getArchivedSessionsDir()];
  const seen = new Set<string>();
  const entries: SessionListEntry[] = [];

  for (const dir of dirs) {
    const files = findFiles(dir, (name) => name.endsWith('.jsonl'));

    for (const filePath of files) {
      let cwd = '';
      let summary: string | undefined;
      let updatedAt: Date | undefined;
      let id = extractIdFromFilename(filePath);
      let isValidSession = false;
      let sawConversation = false;

      // Get file mtime as fallback for updatedAt
      try {
        const fstat = fs.statSync(filePath);
        updatedAt = fstat.mtime;
      } catch {
        updatedAt = new Date();
      }

      await scanJsonlHead(filePath, 50, (parsed, _lineIndex) => {
        const event = parsed as CodexEvent;

        // First line must be session_meta to be a valid Codex session
        if (_lineIndex === 0) {
          if (event.type !== 'session_meta' || !event.payload) return 'stop';
          isValidSession = true;
          const p = event.payload as Record<string, unknown>;
          if (typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;
          if (typeof p.id === 'string' && p.id) id = p.id;
          return 'continue';
        }

        if (event.timestamp) {
          const ts = new Date(event.timestamp);
          if (!updatedAt || ts > updatedAt) updatedAt = ts;
        }

        // Track any non-bootstrap user or assistant message as "real conversation"
        if (!sawConversation) {
          if (event.type === 'response_item' && event.payload) {
            const p = event.payload as Record<string, unknown>;
            if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
              const text = extractUserText(p.content);
              if (text && (p.role === 'assistant' || !isBootstrapMessage(text))) {
                sawConversation = true;
              }
            }
          } else if (event.type === 'event_msg' && event.payload) {
            const p = event.payload as Record<string, unknown>;
            if (p.type === 'user_message' && typeof p.message === 'string') {
              if (!isBootstrapMessage(p.message)) sawConversation = true;
            } else if (p.type === 'agent_message') {
              sawConversation = true;
            }
          }
        }

        // Capture first non-bootstrap user message as summary
        if (!summary) {
          if (event.type === 'response_item' && event.payload) {
            const p = event.payload as Record<string, unknown>;
            if (p.type === 'message' && p.role === 'user') {
              const text = extractUserText(p.content);
              if (text && !isBootstrapMessage(text)) {
                summary = truncate(text.replace(/\s+/g, ' ').trim(), 120);
              }
            }
          } else if (event.type === 'event_msg' && event.payload) {
            const p = event.payload as Record<string, unknown>;
            if (p.type === 'user_message' && typeof p.message === 'string') {
              if (!isBootstrapMessage(p.message)) {
                summary = truncate(p.message.replace(/\s+/g, ' ').trim(), 120);
              }
            }
          }
        }

        return 'continue';
      });

      if (!isValidSession) continue;

      // Deduplicate across sessions and archived_sessions
      if (seen.has(id)) continue;
      seen.add(id);

      entries.push({
        id,
        source: 'codex',
        cwd,
        updatedAt: updatedAt ?? new Date(),
        summary,
        filePath,
        isEmpty: !sawConversation,
      });
    }
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'codex',
  label: 'Codex',
  color: '#FF8C00',
  getDataDir: getSessionsDir,
  find: findCodexSessions,
  parse: parseCodexSession,
});
