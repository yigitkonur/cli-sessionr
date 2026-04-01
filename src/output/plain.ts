import { homedir } from 'node:os';
import type {
  Formatter,
  NormalizedSession,
  NormalizedMessage,
  VerbosityPreset,
  SessionListEntry,
  ContentBlock,
  SliceMeta,
} from '../types.js';
import { truncate } from '../parsers/common.js';
import { getAdapter } from '../parsers/registry.js';

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function createPlainFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      return renderInfoBlock(session);
    },

    read(
      session: NormalizedSession,
      messages: NormalizedMessage[],
      from: number,
      to: number,
      preset: VerbosityPreset,
      meta?: SliceMeta,
    ): string {
      const lines: string[] = [];

      // Full info block
      lines.push(renderInfoBlock(session));

      // Page/range indicator
      if (meta?.page) {
        lines.push(`Page ${meta.page.current} of ${meta.page.total} | Messages ${from}-${to} of ${session.stats.totalMessages}`);
      } else {
        lines.push(`Showing ${from}-${to} of ${session.stats.totalMessages}`);
      }
      lines.push('---');

      for (const msg of messages) {
        lines.push('');
        lines.push(`## #${msg.index} ${msg.role}`);

        const rendered = msg.blocks
          .map((block) => renderBlock(block, preset))
          .filter((s) => s.trim());

        if (rendered.length === 0) {
          lines.push('[empty]');
        } else {
          lines.push(...rendered);
        }
      }

      // Preset hint
      if (meta?.detail_hint) {
        const h = meta.detail_hint;
        const parts: string[] = [];
        if (h.hidden_tool_calls > 0) parts.push(`${h.hidden_tool_calls} tool calls hidden`);
        if (h.truncated_results > 0) parts.push(`${h.truncated_results} tool results truncated`);
        if (h.thinking_hidden) parts.push('thinking blocks hidden');
        if (parts.length > 0) {
          lines.push('');
          lines.push(`Note: ${parts.join(', ')} by the "${h.current_preset}" preset.`);
          lines.push('Available presets:');
          lines.push('  minimal  — 80 char content, no tool args/results, no thinking');
          lines.push('  standard — 500 char content, 80 char tool results, no thinking');
          lines.push('  verbose  — 2K char content, 500 char tool results, 200 char thinking');
          lines.push('  full     — everything, no truncation');
          if (h.upgrade_options.length > 0) {
            lines.push('Try:');
            for (const o of h.upgrade_options) {
              lines.push(`  ${o.command}`);
            }
          }
        }
      }

      // Cursor navigation
      if (meta?.cursor) {
        lines.push('');
        lines.push('---');
        if (meta.page) {
          lines.push(`Page ${meta.page.current} of ${meta.page.total}`);
        }
        if (meta.cursor.prev) lines.push(`Prev: ${meta.cursor.prev}`);
        if (meta.cursor.next) lines.push(`Next: ${meta.cursor.next}`);
        if (meta.cursor.first && meta.cursor.prev) lines.push(`First: ${meta.cursor.first}`);
      }

      // Resume hint
      if (meta?.next_action) {
        if (!meta.cursor) { lines.push(''); lines.push('---'); }
        lines.push(`Resume: ${meta.next_action.resume}`);
      }

      lines.push('');
      return lines.join('\n');
    },

    list(entries: SessionListEntry[]): string {
      const lines: string[] = [];
      lines.push(`# Sessions (${entries.length} most recent)`);
      lines.push('');
      lines.push('| Source | Updated | CWD | ID | Summary |');
      lines.push('|---|---|---|---|---|');

      for (const e of entries) {
        const sum = e.summary ? truncate(e.summary, 50) : '';
        lines.push(
          `| ${e.source} | ${relativeTime(e.updatedAt)} | ${e.cwd} | ${shortId(e.id)} | ${sum} |`,
        );
      }

      if (entries.length > 0) {
        lines.push('');
        lines.push(`Tip: sessionr read ${shortId(entries[0].id)} to open a session`);
      }

      lines.push('');
      return lines.join('\n');
    },

    error(err: Error): string {
      return `Error: ${err.message}`;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function sourceLabel(source: string): string {
  const adapter = getAdapter(source as import('../types.js').SessionSource);
  return adapter?.label ?? source;
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function relativeTime(d: Date): string {
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  return formatDate(d);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

function formatToolInput(input: Record<string, unknown>, maxChars: number): string {
  if (maxChars === Infinity) return JSON.stringify(input, null, 2);
  // For limited chars, show key=value pairs instead of raw JSON to avoid mid-string cuts
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}: ${valStr}`);
  }
  const joined = `{ ${parts.join(', ')} }`;
  return truncate(joined, maxChars);
}

function renderBlock(block: ContentBlock, preset: VerbosityPreset): string {
  switch (block.type) {
    case 'text':
      return truncate(block.text, preset.maxContentChars);

    case 'thinking':
      if (!preset.showThinking) return '';
      return `<thinking>\n${truncate(block.text, preset.maxThinkingChars)}\n</thinking>`;

    case 'tool_use': {
      if (!preset.showToolArgs) return `${block.name}`;
      const inputStr = formatToolInput(block.input, preset.maxToolInputChars);
      return `${block.name} ${inputStr}`;
    }

    case 'tool_result': {
      if (!preset.showToolResults) return '[result hidden]';
      const content = truncate(block.content, preset.maxToolResultChars);
      const prefix = block.isError ? '[ERROR] ' : '';
      return `${prefix}${content}`;
    }
  }
}

function renderInfoBlock(session: NormalizedSession): string {
  const { id, source, metadata: m, stats: s } = session;
  const lines: string[] = [];

  lines.push(`# Session ${shortId(id)}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Source | ${sourceLabel(source)} |`);
  if (m.model) lines.push(`| Model | ${m.model} |`);
  lines.push(`| CWD | ${shortenPath(m.cwd)} |`);
  if (m.gitBranch) lines.push(`| Branch | ${m.gitBranch} |`);
  if (m.gitRepo) lines.push(`| Repo | ${m.gitRepo} |`);
  lines.push(`| Created | ${formatDate(m.createdAt)} |`);
  lines.push(`| Updated | ${formatDate(m.updatedAt)} |`);
  lines.push(`| File Size | ${formatBytes(m.fileBytes)} |`);
  lines.push(`| Raw Lines | ${m.rawLineCount.toLocaleString()} |`);
  if (s.durationMs != null) lines.push(`| Duration | ${formatDuration(s.durationMs)} |`);

  lines.push('');
  lines.push(`## Messages (${s.totalMessages} total)`);
  lines.push('');
  const roleEntries: [string, number][] = [
    ['user', s.byRole.user],
    ['assistant', s.byRole.assistant],
    ['system', s.byRole.system],
    ['tool_use', s.byRole.toolUse],
    ['tool_result', s.byRole.toolResult],
  ];
  for (const [role, count] of roleEntries) {
    if (count > 0) {
      const pct = ((count / s.totalMessages) * 100).toFixed(1);
      lines.push(`- ${role}: ${count} (${pct}%)`);
    }
  }

  if (Object.keys(s.byBlockType).length > 0) {
    lines.push('');
    lines.push('## Content Blocks');
    for (const [type, count] of Object.entries(s.byBlockType).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${type}: ${count}`);
    }
  }

  if (s.tokenUsage) {
    lines.push('');
    lines.push('## Token Usage');
    lines.push(`- Input: ${s.tokenUsage.input.toLocaleString()}`);
    lines.push(`- Output: ${s.tokenUsage.output.toLocaleString()}`);
    if (s.tokenUsage.cacheRead != null)
      lines.push(`- Cache Read: ${s.tokenUsage.cacheRead.toLocaleString()}`);
    if (s.tokenUsage.cacheCreation != null)
      lines.push(`- Cache Creation: ${s.tokenUsage.cacheCreation.toLocaleString()}`);
    if (s.tokenUsage.thinking != null)
      lines.push(`- Thinking: ${s.tokenUsage.thinking.toLocaleString()}`);
  }

  if (s.toolFrequency.length > 0) {
    lines.push('');
    lines.push('## Top Tools');
    for (const t of s.toolFrequency) {
      const errSuffix = t.errors > 0 ? ` (${t.errors} errors)` : '';
      lines.push(`- ${t.name}: ${t.count}${errSuffix}`);
    }
  }

  if (s.filesModified.length > 0) {
    lines.push('');
    lines.push('## Files Modified');
    for (const f of s.filesModified) {
      lines.push(`- ${shortenPath(f)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
