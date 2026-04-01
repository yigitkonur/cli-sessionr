import chalk from 'chalk';
import type {
  Formatter,
  NormalizedSession,
  NormalizedMessage,
  VerbosityPreset,
  SessionListEntry,
  SessionSource,
  ContentBlock,
  SliceMeta,
} from '../types.js';
import { truncate } from '../parsers/common.js';
import { getAdapter } from '../parsers/registry.js';

export function createTtyFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      const { id, source, metadata: m, stats: s } = session;
      const lines: string[] = [];

      lines.push(chalk.bold(`SESSION ${shortId(id)}`));
      lines.push('');

      lines.push(`${chalk.cyan('Source')}      ${colorSource(source)}`);
      if (m.model) lines.push(`${chalk.cyan('Model')}       ${m.model}`);
      lines.push(`${chalk.cyan('CWD')}         ${m.cwd}`);
      if (m.gitBranch) lines.push(`${chalk.cyan('Branch')}      ${m.gitBranch}`);
      if (m.gitRepo) lines.push(`${chalk.cyan('Repo')}        ${m.gitRepo}`);
      lines.push(`${chalk.cyan('Created')}     ${formatDate(m.createdAt)}`);
      lines.push(`${chalk.cyan('Updated')}     ${formatDate(m.updatedAt)}`);
      lines.push(`${chalk.cyan('File Size')}   ${formatBytes(m.fileBytes)}`);
      lines.push(`${chalk.cyan('Raw Lines')}   ${m.rawLineCount.toLocaleString()}`);
      if (s.durationMs != null)
        lines.push(`${chalk.cyan('Duration')}    ${formatDuration(s.durationMs)}`);

      lines.push('');
      lines.push(chalk.bold(`Messages (${s.totalMessages} total)`));
      lines.push('');

      const roleEntries: [string, number][] = [
        ['user', s.byRole.user],
        ['assistant', s.byRole.assistant],
        ['system', s.byRole.system],
        ['tool_use', s.byRole.toolUse],
        ['tool_result', s.byRole.toolResult],
      ];

      const maxLabel = Math.max(...roleEntries.map(([r]) => r.length));

      for (const [role, count] of roleEntries) {
        if (count > 0) {
          const fraction = count / s.totalMessages;
          const pct = (fraction * 100).toFixed(1).padStart(5);
          const countStr = String(count).padStart(4);
          lines.push(
            `  ${role.padEnd(maxLabel)}  ${bar(fraction)}  ${countStr}  ${pct}%`,
          );
        }
      }

      if (Object.keys(s.byBlockType).length > 0) {
        lines.push('');
        lines.push(chalk.bold('Content Blocks'));
        for (const [type, count] of Object.entries(s.byBlockType).sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${type}: ${count}`);
        }
      }

      if (s.tokenUsage) {
        lines.push('');
        lines.push(chalk.bold('Token Usage'));
        lines.push(`  ${chalk.cyan('Input')}           ${s.tokenUsage.input.toLocaleString()}`);
        lines.push(`  ${chalk.cyan('Output')}          ${s.tokenUsage.output.toLocaleString()}`);
        if (s.tokenUsage.cacheRead != null)
          lines.push(`  ${chalk.cyan('Cache Read')}      ${s.tokenUsage.cacheRead.toLocaleString()}`);
        if (s.tokenUsage.cacheCreation != null)
          lines.push(`  ${chalk.cyan('Cache Creation')}  ${s.tokenUsage.cacheCreation.toLocaleString()}`);
        if (s.tokenUsage.thinking != null)
          lines.push(`  ${chalk.cyan('Thinking')}        ${s.tokenUsage.thinking.toLocaleString()}`);
      }

      if (s.toolFrequency.length > 0) {
        lines.push('');
        lines.push(chalk.bold('Top Tools'));
        for (const t of s.toolFrequency) {
          const errSuffix = t.errors > 0 ? chalk.red(` (${t.errors} errors)`) : '';
          lines.push(`  ${t.name}: ${t.count}${errSuffix}`);
        }
      }

      if (s.filesModified.length > 0) {
        lines.push('');
        lines.push(chalk.bold('Files Modified'));
        for (const f of s.filesModified) {
          lines.push(`  ${f}`);
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
        chalk.bold(
          `Session ${shortId(session.id)} | Messages ${from}-${to} of ${session.stats.totalMessages}`,
        ),
      );

      for (const msg of messages) {
        lines.push('');
        lines.push(messageHeader(msg.index, msg.role));

        const rendered = msg.blocks
          .map((block) => renderBlock(block, preset))
          .filter((s) => s.trim());

        if (rendered.length === 0) {
          lines.push(chalk.dim('[empty]'));
        } else {
          lines.push(...rendered);
        }
      }

      // Resume hint
      if (meta?.next_action) {
        lines.push('');
        lines.push(chalk.dim('\u2500'.repeat(60)));
        lines.push(chalk.dim(`${meta.next_action.description}:`));
        lines.push(chalk.dim('  Interactive:      ') + chalk.cyan(meta.next_action.interactive));
        lines.push(chalk.dim('  Non-interactive:  ') + chalk.cyan(meta.next_action.non_interactive));
        if (!meta.next_action.verified) {
          lines.push(chalk.yellow('  [!] Resume syntax not verified — check the tool\'s --help'));
        }
      }

      lines.push('');
      return lines.join('\n');
    },

    list(entries: SessionListEntry[]): string {
      const lines: string[] = [];
      lines.push(chalk.bold(`Sessions (${entries.length} most recent)`));
      lines.push('');

      for (const e of entries) {
        const src = colorSource(e.source);
        const date = chalk.dim(formatDate(e.updatedAt));
        const id = chalk.cyan(shortId(e.id));
        const sum = e.summary ? chalk.dim(truncate(e.summary, 50)) : '';
        lines.push(`  ${src}  ${date}  ${id}  ${e.cwd}`);
        if (sum) lines.push(`    ${sum}`);
      }

      lines.push('');
      return lines.join('\n');
    },

    error(err: Error): string {
      return `${chalk.red('Error:')} ${err.message}`;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function colorSource(source: SessionSource): string {
  const adapter = getAdapter(source);
  if (adapter) return chalk.hex(adapter.color)(adapter.name);
  return chalk.white(source);
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

function bar(fraction: number, width = 20): string {
  const filled = Math.round(fraction * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

const roleColor: Record<string, (s: string) => string> = {
  user: chalk.blue,
  assistant: chalk.green,
  system: chalk.magenta,
  tool_use: chalk.yellow,
  tool_result: chalk.gray,
};

function messageHeader(index: number, role: string): string {
  const colorFn = roleColor[role] ?? chalk.white;
  const label = colorFn(`#${index} ${role}`);
  const prefix = '\u2500\u2500\u2500 ';
  const suffix = ' ' + '\u2500'.repeat(Math.max(0, 60 - role.length - String(index).length));
  return chalk.dim(prefix) + label + chalk.dim(suffix);
}

function formatToolInput(input: Record<string, unknown>, maxChars: number): string {
  if (maxChars === Infinity) return JSON.stringify(input, null, 2);
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
      return chalk.dim(
        `<thinking>\n${truncate(block.text, preset.maxThinkingChars)}\n</thinking>`,
      );

    case 'tool_use': {
      if (!preset.showToolArgs)
        return chalk.yellow(block.name);
      const inputStr = formatToolInput(block.input, preset.maxToolInputChars);
      return `${chalk.yellow(block.name)} ${chalk.dim(inputStr)}`;
    }

    case 'tool_result': {
      if (!preset.showToolResults) return chalk.dim('[result hidden]');
      const content = truncate(block.content, preset.maxToolResultChars);
      if (block.isError) return chalk.red(`[ERROR] ${content}`);
      return chalk.dim(content);
    }
  }
}
