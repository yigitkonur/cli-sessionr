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

export function createPlainFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      const { id, source, metadata: m, stats: s } = session;
      const lines: string[] = [];

      lines.push(`# Session ${shortId(id)}`);
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push(`| Source | ${sourceLabel(source)} |`);
      if (m.model) lines.push(`| Model | ${m.model} |`);
      lines.push(`| CWD | ${m.cwd} |`);
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
          lines.push(`- ${f}`);
        }
      }

      lines.push('');
      return lines.join('\n');
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
      lines.push(
        `# Session ${shortId(session.id)} | Messages ${from}-${to} of ${session.stats.totalMessages}`,
      );

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

      // Resume hint
      if (meta?.next_action) {
        lines.push('');
        lines.push('---');
        lines.push(`${meta.next_action.description}:`);
        lines.push(`  Interactive:      ${meta.next_action.interactive}`);
        lines.push(`  Non-interactive:  ${meta.next_action.non_interactive}`);
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
          `| ${e.source} | ${formatDate(e.updatedAt)} | ${e.cwd} | ${shortId(e.id)} | ${sum} |`,
        );
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
