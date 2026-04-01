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
import { isSqliteAvailable, queryAll, type SqliteRow } from './sqlite.js';
import { registerSource } from './registry.js';

// ── Constants ───────────────────────────────────────────────────────────────

const GOOSE_DIR = path.join(os.homedir(), '.local', 'share', 'goose', 'sessions');
const DB_PATH = path.join(GOOSE_DIR, 'sessions.db');
const CONFIG_PATH = path.join(os.homedir(), '.config', 'goose', 'config.yaml');
const MAX_TOOL_RESULT_PREVIEW = 500;

// ── Config model (lazy) ────────────────────────────────────────────────────

let _configModel: string | null | undefined;

function getConfigModel(): string | null {
  if (_configModel !== undefined) return _configModel;
  _configModel = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const match = raw.match(/^GOOSE_MODEL:\s*(.+)$/m);
    if (match) _configModel = match[1].trim();
  } catch {
    // config not available
  }
  return _configModel;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseTimestamp(ts: unknown): Date {
  if (!ts) return new Date();
  if (typeof ts === 'number') return new Date(ts);
  const d = new Date(ts as string);
  return isNaN(d.getTime()) ? new Date() : d;
}

function cleanTitle(title: string | null | undefined): string | undefined {
  if (!title) return undefined;
  return title.substring(0, 120).trim() || undefined;
}

function extractSessionModel(row: SqliteRow): string | null {
  const configJson = row.model_config_json;
  if (typeof configJson === 'string' && configJson) {
    try {
      const cfg = JSON.parse(configJson) as Record<string, unknown>;
      if (typeof cfg.model === 'string') return cfg.model;
      if (typeof cfg.model_id === 'string') return cfg.model_id;
    } catch {
      // invalid JSON
    }
  }
  return null;
}

// ── Content part mapping ────────────────────────────────────────────────────

interface GoosePart {
  type?: string;
  text?: string;
  toolCall?: { value?: { name?: string; arguments?: Record<string, unknown> } };
  toolRequest?: { value?: { name?: string; arguments?: Record<string, unknown> } };
  toolResult?: { status?: string; value?: Array<{ type?: string; text?: string }> };
  toolResponse?: { status?: string; value?: Array<{ type?: string; text?: string }> };
}

function mapContentParts(parts: GoosePart[]): {
  blocks: ContentBlock[];
  toolNames: string[];
  toolErrors: string[];
} {
  const blocks: ContentBlock[] = [];
  const toolNames: string[] = [];
  const toolErrors: string[] = [];
  let callCounter = 0;

  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    // toolCall / toolRequest -> tool_use
    const tc = part.toolCall ?? part.toolRequest;
    if (tc) {
      const value = tc.value ?? ({} as { name?: string; arguments?: Record<string, unknown> });
      const name = value.name || 'tool';
      const input = value.arguments || {};
      const id = `goose_call_${callCounter++}`;
      toolNames.push(name);
      blocks.push({ type: 'tool_use', id, name, input });
      continue;
    }

    // toolResult / toolResponse -> tool_result
    const tr = part.toolResult ?? part.toolResponse;
    if (tr) {
      let preview = '';
      if (Array.isArray(tr.value)) {
        preview = tr.value
          .filter((v) => v.type === 'text')
          .map((v) => v.text ?? '')
          .join('\n')
          .substring(0, MAX_TOOL_RESULT_PREVIEW);
      }
      const isError = tr.status === 'error';
      if (isError && toolNames.length > 0) {
        toolErrors.push(toolNames[toolNames.length - 1]);
      }
      blocks.push({
        type: 'tool_result',
        toolUseId: `goose_call_${callCounter > 0 ? callCounter - 1 : 0}`,
        content: preview,
        isError,
      });
      continue;
    }

    // type === 'toolRequest' or 'toolResponse' at top level (alternate shape)
    if (part.type === 'toolRequest' || part.type === 'toolCall') {
      const value = (part as Record<string, unknown>).toolCall as
        | { value?: { name?: string; arguments?: Record<string, unknown> } }
        | undefined;
      const v = value?.value ?? ({} as { name?: string; arguments?: Record<string, unknown> });
      const name = v.name || 'tool';
      const input = v.arguments || {};
      const id = `goose_call_${callCounter++}`;
      toolNames.push(name);
      blocks.push({ type: 'tool_use', id, name, input });
      continue;
    }

    if (part.type === 'toolResponse' || part.type === 'toolResult') {
      const value = (part as Record<string, unknown>).toolResult as
        | { status?: string; value?: Array<{ type?: string; text?: string }> }
        | undefined;
      let preview = '';
      if (value && Array.isArray(value.value)) {
        preview = value.value
          .filter((v) => v.type === 'text')
          .map((v) => v.text ?? '')
          .join('\n')
          .substring(0, MAX_TOOL_RESULT_PREVIEW);
      }
      const isError = value?.status === 'error';
      if (isError && toolNames.length > 0) {
        toolErrors.push(toolNames[toolNames.length - 1]);
      }
      blocks.push({
        type: 'tool_result',
        toolUseId: `goose_call_${callCounter > 0 ? callCounter - 1 : 0}`,
        content: preview,
        isError,
      });
    }
  }

  return { blocks, toolNames, toolErrors };
}

// ── Explode blocks into NormalizedMessages ───────────────────────────────────

interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

function explodeGooseBlocks(
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

// ── Parse SQLite session ────────────────────────────────────────────────────

function parseDbMessages(
  sessionId: string,
  model: string | null,
): {
  exploded: ExplodedMessage[];
  toolNames: string[];
  toolErrors: string[];
} {
  const rows = queryAll(
    DB_PATH,
    `SELECT role, content_json, created_timestamp FROM messages
     WHERE session_id = ? ORDER BY created_timestamp ASC`,
    [sessionId],
  );

  const allExploded: ExplodedMessage[] = [];
  const allToolNames: string[] = [];
  const allToolErrors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contentStr = row.content_json as string | undefined;
    if (!contentStr) continue;

    let parts: GoosePart[];
    try {
      parts = JSON.parse(contentStr);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;

    const role = (row.role as string) || 'assistant';
    const ts = parseTimestamp(row.created_timestamp);
    const { blocks, toolNames, toolErrors } = mapContentParts(parts);

    allToolNames.push(...toolNames);
    allToolErrors.push(...toolErrors);

    if (blocks.length > 0) {
      allExploded.push(...explodeGooseBlocks(role, blocks, ts, i));
    }
  }

  return { exploded: allExploded, toolNames: allToolNames, toolErrors: allToolErrors };
}

// ── Parse JSONL session ─────────────────────────────────────────────────────

interface GooseJsonlLine {
  role?: string;
  content?: string | GoosePart[];
  created?: string | number;
  working_dir?: string;
}

function parseJsonlMessages(
  lines: GooseJsonlLine[],
): {
  exploded: ExplodedMessage[];
  toolNames: string[];
  toolErrors: string[];
  workingDir: string;
  firstTimestamp: Date | undefined;
} {
  const allExploded: ExplodedMessage[] = [];
  const allToolNames: string[] = [];
  const allToolErrors: string[] = [];
  let workingDir = '';
  let firstTimestamp: Date | undefined;

  for (let i = 0; i < lines.length; i++) {
    const obj = lines[i];
    if (!obj.role) continue;

    if (!workingDir && obj.working_dir) workingDir = obj.working_dir;
    if (!firstTimestamp && obj.created) firstTimestamp = parseTimestamp(obj.created);

    let parts: GoosePart[];
    try {
      const raw = obj.content;
      if (typeof raw === 'string') {
        parts = JSON.parse(raw);
      } else if (Array.isArray(raw)) {
        parts = raw;
      } else {
        // content might be plain text
        if (typeof raw === 'string' && raw) {
          allExploded.push({
            role: obj.role === 'user' ? 'user' : 'assistant',
            content: raw,
            blocks: [{ type: 'text', text: raw }],
            timestamp: parseTimestamp(obj.created),
            rawLineIndex: i,
          });
        }
        continue;
      }
    } catch {
      // content might be a plain string that isn't JSON
      if (typeof obj.content === 'string' && obj.content) {
        allExploded.push({
          role: obj.role === 'user' ? 'user' : 'assistant',
          content: obj.content,
          blocks: [{ type: 'text', text: obj.content }],
          timestamp: parseTimestamp(obj.created),
          rawLineIndex: i,
        });
      }
      continue;
    }

    if (!Array.isArray(parts)) continue;

    const ts = parseTimestamp(obj.created);
    const { blocks, toolNames, toolErrors } = mapContentParts(parts);

    allToolNames.push(...toolNames);
    allToolErrors.push(...toolErrors);

    if (blocks.length > 0) {
      allExploded.push(...explodeGooseBlocks(obj.role, blocks, ts, i));
    }
  }

  return {
    exploded: allExploded,
    toolNames: allToolNames,
    toolErrors: allToolErrors,
    workingDir,
    firstTimestamp,
  };
}

// ── Compute stats ───────────────────────────────────────────────────────────

function computeStats(
  messages: NormalizedMessage[],
  toolNames: string[],
  toolErrors: string[],
  inputTokens: number,
  outputTokens: number,
): SessionStats {
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

  // Build tool frequency
  const toolCounts = new Map<string, { count: number; errors: number }>();
  for (const name of toolNames) {
    const existing = toolCounts.get(name) ?? { count: 0, errors: 0 };
    existing.count++;
    toolCounts.set(name, existing);
  }
  for (const name of toolErrors) {
    const existing = toolCounts.get(name);
    if (existing) existing.errors++;
  }

  const toolFrequency = Array.from(toolCounts.entries())
    .map(([name, { count, errors }]) => ({ name, count, errors }))
    .sort((a, b) => b.count - a.count);

  const hasTokens = inputTokens > 0 || outputTokens > 0;

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
    tokenUsage: hasTokens ? { input: inputTokens, output: outputTokens } : undefined,
    toolFrequency,
    filesModified: [],
    durationMs,
  };
}

// ── parseGooseSession ───────────────────────────────────────────────────────

export async function parseGooseSession(filePath: string): Promise<NormalizedSession> {
  const configModel = getConfigModel();

  // Determine if this is a DB reference (session ID) or JSONL file path
  const isJsonl = filePath.endsWith('.jsonl');
  const sessionId = isJsonl
    ? path.basename(filePath, '.jsonl')
    : path.basename(filePath, path.extname(filePath));

  let exploded: ExplodedMessage[] = [];
  let toolNames: string[] = [];
  let toolErrors: string[] = [];
  let cwd = '';
  let model = configModel ?? undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let fileBytes = 0;
  let rawLineCount = 0;
  let createdAt: Date | undefined;
  let updatedAt: Date | undefined;

  // Try SQLite first
  if (isSqliteAvailable() && fs.existsSync(DB_PATH)) {
    const sessionRows = queryAll(
      DB_PATH,
      `SELECT id, name, description, working_dir, created_at, updated_at,
              input_tokens, output_tokens, model_config_json
       FROM sessions WHERE id = ?`,
      [sessionId],
    );

    if (sessionRows.length > 0) {
      const row = sessionRows[0];
      cwd = (row.working_dir as string) || '';
      createdAt = parseTimestamp(row.created_at);
      updatedAt = parseTimestamp(row.updated_at);
      inputTokens = (row.input_tokens as number) || 0;
      outputTokens = (row.output_tokens as number) || 0;
      model = extractSessionModel(row) || configModel || undefined;

      const dbResult = parseDbMessages(sessionId, model || null);
      exploded = dbResult.exploded;
      toolNames = dbResult.toolNames;
      toolErrors = dbResult.toolErrors;
    }
  }

  // Fallback to JSONL if no DB results
  if (exploded.length === 0 && isJsonl && fs.existsSync(filePath)) {
    const fileStats = await getFileStats(filePath);
    fileBytes = fileStats.bytes;
    rawLineCount = fileStats.lines;

    const lines = await readJsonlFile<GooseJsonlLine>(filePath);
    const jsonlResult = parseJsonlMessages(lines);
    exploded = jsonlResult.exploded;
    toolNames = jsonlResult.toolNames;
    toolErrors = jsonlResult.toolErrors;
    if (jsonlResult.workingDir) cwd = jsonlResult.workingDir;
    if (jsonlResult.firstTimestamp) createdAt = jsonlResult.firstTimestamp;
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

  // Compute timestamps from messages if not already set
  if (!createdAt || !updatedAt) {
    const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
    if (timestamps.length > 0) {
      if (!createdAt) createdAt = new Date(Math.min(...timestamps));
      if (!updatedAt) updatedAt = new Date(Math.max(...timestamps));
    }
  }

  const now = new Date();
  const metadata: SessionMetadata = {
    cwd: cwd || path.dirname(filePath),
    model,
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
    fileBytes,
    rawLineCount,
  };

  const stats = computeStats(messages, toolNames, toolErrors, inputTokens, outputTokens);

  return {
    id: sessionId,
    source: 'goose',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── findGooseSessions ───────────────────────────────────────────────────────

export async function findGooseSessions(): Promise<SessionListEntry[]> {
  const entries: SessionListEntry[] = [];
  const seen = new Set<string>();
  const configModel = getConfigModel();

  // --- SQLite sessions ---
  if (isSqliteAvailable() && fs.existsSync(DB_PATH)) {
    const rows = queryAll(
      DB_PATH,
      `SELECT id, name, description, working_dir, created_at, updated_at,
              input_tokens, output_tokens, model_config_json,
              (SELECT count(*) FROM messages m WHERE m.session_id = s.id) as msg_count
       FROM sessions s ORDER BY updated_at DESC`,
    );

    for (const row of rows) {
      const id = row.id as string;
      seen.add(id);

      entries.push({
        id,
        source: 'goose',
        cwd: (row.working_dir as string) || '',
        updatedAt: parseTimestamp(row.updated_at),
        summary: cleanTitle((row.name as string) || (row.description as string)),
        filePath: DB_PATH,
      });
    }
  }

  // --- Legacy JSONL files ---
  if (fs.existsSync(GOOSE_DIR)) {
    let files: string[];
    try {
      files = fs.readdirSync(GOOSE_DIR).filter((f) => f.endsWith('.jsonl'));
    } catch {
      files = [];
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);

      const fullPath = path.join(GOOSE_DIR, file);
      let cwd = '';
      let updatedAt = new Date(0);
      let summary: string | undefined;

      // Get file mtime as fallback
      try {
        const stat = fs.statSync(fullPath);
        updatedAt = stat.mtime;
      } catch {
        updatedAt = new Date();
      }

      await scanJsonlHead(fullPath, 30, (parsed) => {
        const obj = parsed as GooseJsonlLine;

        if (!cwd && obj.working_dir) cwd = obj.working_dir;

        if (obj.created) {
          const ts = parseTimestamp(obj.created);
          if (ts.getTime() > updatedAt.getTime()) updatedAt = ts;
        }

        // First user text message as summary
        if (!summary && obj.role === 'user' && obj.content) {
          let parts: GoosePart[];
          try {
            parts =
              typeof obj.content === 'string'
                ? JSON.parse(obj.content)
                : (obj.content as GoosePart[]);
          } catch {
            return 'continue';
          }
          if (Array.isArray(parts)) {
            const text = parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .join(' ');
            if (text) summary = truncate(text.replace(/\s+/g, ' ').trim(), 120);
          }
        }

        if (cwd && summary) return 'stop';
        return 'continue';
      });

      entries.push({
        id: sessionId,
        source: 'goose',
        cwd,
        updatedAt,
        summary,
        filePath: fullPath,
      });
    }
  }

  // Sort by updatedAt descending
  entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return entries;
}

// ── Registry ────────────────────────────────────────────────────────────────

registerSource({
  name: 'goose',
  label: 'Goose',
  color: '#7B2D8B',
  find: findGooseSessions,
  parse: parseGooseSession,
});
