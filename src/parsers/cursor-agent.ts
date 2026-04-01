/**
 * Cursor Agent session parser.
 *
 * Storage layout:
 *   ~/.cursor/projects/<hash>/agent-transcripts/<id>.jsonl        (flat)
 *   ~/.cursor/projects/<hash>/agent-transcripts/<id>/<id>.jsonl   (nested)
 *
 * JSONL line format:
 *   {role: "user"|"assistant", message: {content: [{type:"text", text:"..."}]}}
 *
 * No per-message timestamps — file mtime is used for all messages.
 * No token info, no tool blocks (text ContentBlocks only).
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
import { readJsonlFile, getFileStats } from './common.js';
import { registerSource } from './registry.js';

// ── Constants ──────────────────────────────────────────────────────────────

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

// ── Raw JSONL types ────────────────────────────────────────────────────────

interface RawContentPart {
  type: string;
  text?: string;
}

interface RawLine {
  role: 'user' | 'assistant';
  message?: {
    content?: RawContentPart[];
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode a Cursor project directory name back to a folder path.
 * The encoding replaces `/` with `-`. We reconstruct by prepending `/`
 * and replacing `-` back with `/`. If the candidate path exists on disk,
 * use it; otherwise fall back to trying common split points.
 */
function decodeProjectDir(dirName: string): string {
  const candidate = '/' + dirName.replace(/-/g, '/');
  if (fs.existsSync(candidate)) return candidate;

  // Fallback: try splitting at different positions
  const parts = dirName.split('-');
  for (let i = 2; i < parts.length; i++) {
    const prefix = '/' + parts.slice(0, i).join('/');
    const suffix = parts.slice(i).join('-');
    const full = path.join(prefix, suffix);
    if (fs.existsSync(full)) return full;
  }

  return candidate;
}

/**
 * Strip XML wrappers from user text content:
 *   <user_query>...</user_query> → extract inner text
 *   <attached_files>...</attached_files> → remove, capture file paths
 *   <image_files>...</image_files> → replace with [image]
 */
function cleanUserText(text: string): { text: string; fileRefs: string[] } {
  const fileRefs: string[] = [];

  // Strip <user_query> wrapper
  let cleaned = text.replace(/<\/?user_query>/g, '').trim();

  // Extract file references from <attached_files> and remove them
  cleaned = cleaned
    .replace(/<attached_files>([\s\S]*?)<\/attached_files>/g, (_, inner: string) => {
      const paths = inner.match(/path="([^"]+)"/g);
      if (paths) {
        for (const pm of paths) {
          const fp = pm.match(/path="([^"]+)"/);
          if (fp?.[1]) fileRefs.push(fp[1]);
        }
      }
      return '';
    })
    .trim();

  // Replace image blocks with placeholder
  cleaned = cleaned.replace(/<image_files>[\s\S]*?<\/image_files>/g, '[image]').trim();

  return { text: cleaned, fileRefs };
}

/**
 * Extract the first user text from parsed entries for use as session summary.
 */
function extractFirstUserText(entries: RawLine[]): string | null {
  for (const e of entries) {
    if (e.role !== 'user') continue;
    const parts = e.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        const { text } = cleanUserText(p.text);
        if (text) return text.substring(0, 120);
      }
    }
  }
  return null;
}

// ── Main parser ────────────────────────────────────────────────────────────

export async function parseCursorAgentSession(filePath: string): Promise<NormalizedSession> {
  const rawLines = await readJsonlFile<RawLine>(filePath);
  const { lines: rawLineCount, bytes: fileBytes } = await getFileStats(filePath);

  // No per-message timestamps — use file mtime for all messages
  let fileMtime: Date;
  try {
    const stat = fs.statSync(filePath);
    fileMtime = stat.mtime;
  } catch {
    fileMtime = new Date();
  }

  // Build NormalizedMessage[] — only text blocks, no tool explosion needed
  const messages: NormalizedMessage[] = [];
  const filesReferenced = new Set<string>();

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const line = rawLines[lineIdx]!;
    const parts = line.message?.content;
    if (!Array.isArray(parts)) continue;

    if (line.role === 'user') {
      const textParts: string[] = [];
      const allBlocks: ContentBlock[] = [];

      for (const p of parts) {
        if (p.type === 'text' && p.text) {
          const { text, fileRefs } = cleanUserText(p.text);
          if (text) {
            textParts.push(text);
            allBlocks.push({ type: 'text', text });
          }
          for (const f of fileRefs) {
            filesReferenced.add(f);
            textParts.push(`[file: ${f}]`);
          }
        }
      }

      if (textParts.length > 0) {
        messages.push({
          index: messages.length + 1,
          role: 'user',
          timestamp: fileMtime,
          content: textParts.join('\n'),
          blocks: allBlocks.length > 0 ? allBlocks : [{ type: 'text', text: textParts.join('\n') }],
          rawLineIndex: lineIdx,
        });
      }
    } else if (line.role === 'assistant') {
      const textParts: string[] = [];
      const allBlocks: ContentBlock[] = [];

      for (const p of parts) {
        if (p.type === 'text' && p.text) {
          const text = p.text.trim();
          if (text) {
            textParts.push(text);
            allBlocks.push({ type: 'text', text });
          }
        }
      }

      if (textParts.length > 0) {
        messages.push({
          index: messages.length + 1,
          role: 'assistant',
          timestamp: fileMtime,
          content: textParts.join('\n'),
          blocks: allBlocks,
          rawLineIndex: lineIdx,
        });
      }
    }
  }

  // Compute stats
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
    }
    for (const block of msg.blocks) {
      byBlockType[block.type] = (byBlockType[block.type] || 0) + 1;
    }
  }

  // Derive cwd from parent directory structure
  const transcriptsDir = path.dirname(filePath);
  const projDir = path.basename(
    transcriptsDir.endsWith('agent-transcripts')
      ? path.dirname(transcriptsDir)
      : path.dirname(path.dirname(transcriptsDir)), // nested pattern
  );
  const cwd = decodeProjectDir(projDir);

  const sessionId = path.basename(filePath, '.jsonl');

  const metadata: SessionMetadata = {
    cwd,
    createdAt: fileMtime,
    updatedAt: fileMtime,
    fileBytes,
    rawLineCount,
  };

  const stats: SessionStats = {
    totalMessages: messages.length,
    byRole,
    byBlockType,
    toolFrequency: [],
    filesModified: [],
  };

  return {
    id: sessionId,
    source: 'cursor-agent',
    filePath,
    metadata,
    messages,
    stats,
  };
}

// ── Session discovery ──────────────────────────────────────────────────────

export async function findCursorAgentSessions(): Promise<SessionListEntry[]> {
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR);
  } catch {
    return [];
  }

  const entries: SessionListEntry[] = [];

  for (const projDir of projectDirs) {
    const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projDir, 'agent-transcripts');
    if (!fs.existsSync(transcriptsDir)) continue;

    let dirEntries: string[];
    try {
      dirEntries = fs.readdirSync(transcriptsDir);
    } catch {
      continue;
    }

    const folder = decodeProjectDir(projDir);

    for (const entry of dirEntries) {
      const entryPath = path.join(transcriptsDir, entry);

      // Flat pattern: <id>.jsonl
      if (entry.endsWith('.jsonl')) {
        const sessionId = entry.replace('.jsonl', '');
        try {
          const stat = fs.statSync(entryPath);
          const rawLines = await readJsonlFile<RawLine>(entryPath);
          if (rawLines.length === 0) continue;

          entries.push({
            id: sessionId,
            source: 'cursor-agent',
            cwd: folder,
            updatedAt: stat.mtime,
            summary: extractFirstUserText(rawLines) ?? undefined,
            filePath: entryPath,
          });
        } catch {
          // skip
        }
        continue;
      }

      // Nested pattern: <id>/<id>.jsonl
      try {
        if (fs.statSync(entryPath).isDirectory()) {
          const nestedJsonl = path.join(entryPath, entry + '.jsonl');
          if (fs.existsSync(nestedJsonl)) {
            const stat = fs.statSync(nestedJsonl);
            const rawLines = await readJsonlFile<RawLine>(nestedJsonl);
            if (rawLines.length === 0) continue;

            entries.push({
              id: entry,
              source: 'cursor-agent',
              cwd: folder,
              updatedAt: stat.mtime,
              summary: extractFirstUserText(rawLines) ?? undefined,
              filePath: nestedJsonl,
            });
          }
        }
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
  name: 'cursor-agent',
  label: 'Cursor Agent',
  color: '#00D4AA',
  find: findCursorAgentSessions,
  parse: parseCursorAgentSession,
});
