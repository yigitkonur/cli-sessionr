#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { statsCommand } from './commands/stats.js';
import { readCommand } from './commands/read.js';
import { listCommand } from './commands/list.js';
import { searchCommand } from './commands/search.js';
import { infoCommand } from './commands/info.js';
import { contextExportCommand } from './commands/context.js';
import { diffCommand } from './commands/diff.js';
import { tagCommand } from './commands/tag.js';
import { pruneCommand } from './commands/prune.js';
import { sendCommand } from './commands/send.js';
import { jobStatusCommand, jobWaitCommand, jobCancelCommand, jobListCommand } from './commands/job.js';
import { PRESET_NAMES, DETAIL_LEVELS } from './config.js';
import type { OutputFormat, DetailLevel, ReadOptions, SendOptions } from './types.js';

const SOURCES = 'claude, codex, gemini, copilot, cursor-agent, commandcode, goose, opencode, kiro, zed';
const SOURCES_LIST = ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'commandcode', 'goose', 'opencode', 'kiro', 'zed'];

const program = new Command();

program
  .name('sessionr')
  .description('sessionr v2.5.3 — read, send, and orchestrate AI coding sessions')
  .version('2.5.3')
  .option('--output <format>', 'Output format: json, jsonl, table, text')
  .option('--api-version <n>', 'API version for structured output', '1')
  .option('--timing', 'Include timing_ms in JSON responses');

// Structured error handling for Commander errors
program.exitOverride();
program.configureOutput({
  writeOut: (str) => process.stdout.write(str),
  writeErr: (str) => {
    // Suppress Commander's stderr — errors are handled in the catch block below
    if (process.stdout.isTTY) {
      process.stderr.write(str);
    }
  },
});

// ── Top-level commands ─────────────────────────────────────────────────────

program
  .command('list')
  .argument('[source]', `Filter by source (${SOURCES})`)
  .description('List available sessions')
  .option('-n, --limit <n>', 'Max sessions to list', '20')
  .option('--offset <n>', 'Skip first N sessions (for pagination)', '0')
  .option('-q, --search <query>', 'Search sessions by content')
  .option('--json', '[deprecated] Use --output json')
  .action(async (source: string | undefined, opts: { limit?: string; offset?: string; search?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await listCommand(source, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('read')
  .argument('<session-id>', 'Session ID or prefix (use "sessionr list" to find)')
  .argument('[from]', 'Start message index (1-based)')
  .argument('[to]', 'End message index (1-based)')
  .description('Read session messages with token-aware pagination')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('-p, --preset <name>', `Verbosity preset (${PRESET_NAMES.join(', ')}) [default: verbose for agents, standard for TTY]`)
  .option('-d, --detail <level>', `Detail level (${DETAIL_LEVELS.join(', ')})`)
  .option('--tokens <n>', 'Token budget (env: SESSIONREADER_MAX_TOKENS)')
  .option('--anchor <anchor>', 'Slice anchor: head, tail, search', 'head')
  .option('--search <query>', 'Search query (sets anchor=search)')
  .option('--role <roles>', 'Filter by role (comma-separated: user, assistant, system, tool_use, tool_result)')
  .option('--page <n>', 'Page number (1-based, from head)')
  .option('--before <cursor>', 'Cursor: show messages before this index')
  .option('--after <cursor>', 'Cursor: show messages after this index')
  .option('--if-changed <etag>', 'Only return data if changed since ETag')
  .option('--json', '[deprecated] Use --output json')
  .action(
    async (
      sessionId: string,
      from: string | undefined,
      to: string | undefined,
      opts: Record<string, string | boolean | undefined>,
    ) => {
      warnDeprecatedJson(opts.json as boolean | undefined);
      const parentOpts = program.opts();
      const readOpts: ReadOptions = {
        source: opts.source as string | undefined,
        preset: opts.preset as string | undefined,
        detail: opts.detail as DetailLevel | undefined,
        json: opts.json as boolean | undefined,
        output: parentOpts.output as OutputFormat | undefined,
        tokens: opts.tokens ? parseInt(opts.tokens as string, 10) : undefined,
        anchor: opts.anchor as 'head' | 'tail' | 'search' | undefined,
        search: opts.search as string | undefined,
        role: opts.role as string | undefined,
        page: opts.page ? parseInt(opts.page as string, 10) : undefined,
        before: opts.before ? parseInt(opts.before as string, 10) : undefined,
        after: opts.after ? parseInt(opts.after as string, 10) : undefined,
        ifChanged: opts.ifChanged as string | undefined,
      };

      if (readOpts.ifChanged) {
        const { loadSession } = await import('./discovery.js');
        const { computeETag } = await import('./etag.js');
        try {
          const s = await loadSession(sessionId, readOpts.source as import('./types.js').SessionSource | undefined);
          const etag = computeETag(s);
          if (etag === readOpts.ifChanged) {
            process.exitCode = 42;
            return;
          }
        } catch {
          // proceed normally if session load fails
        }
      }

      await readCommand(sessionId, from, to, readOpts);
    },
  );

program
  .command('stats', { hidden: true })
  .argument('<session-id>', 'Session ID or prefix')
  .description('Show full session statistics')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await statsCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('info', { hidden: true })
  .argument('<session-id>', 'Session ID or prefix')
  .description('Show lightweight session metadata (cheaper than stats)')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await infoCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('search', { hidden: true })
  .description('Search across sessions by content')
  .requiredOption('-q, --query <text>', 'Search query')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--top <n>', 'Max results to return', '10')
  .option('--max-sessions <n>', 'Max sessions to scan (most recent first)', '20')
  .option('--json', '[deprecated] Use --output json')
  .action(async (opts: { query: string; source?: string; top?: string; maxSessions?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await searchCommand({
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('diff', { hidden: true })
  .argument('<id1>', 'First session ID or prefix')
  .argument('<id2>', 'Second session ID or prefix')
  .description('Compare two sessions (structural diff)')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .action(async (id1: string, id2: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await diffCommand(id1, id2, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('tag', { hidden: true })
  .argument('<session-id>', 'Session ID or prefix')
  .description('Add or remove session tags (idempotent)')
  .option('--add <tag>', 'Tag to add')
  .option('--remove <tag>', 'Tag to remove')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .action(async (sessionId: string, opts: { add?: string; remove?: string; source?: string }) => {
    const parentOpts = program.opts();
    await tagCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('prune', { hidden: true })
  .description('Delete old sessions')
  .requiredOption('--older-than <duration>', 'Duration threshold (e.g., 7d, 24h)')
  .option('--dry-run', 'Preview what would be deleted')
  .option('--yes', 'Skip confirmation')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .action(async (opts: { olderThan: string; dryRun?: boolean; yes?: boolean; source?: string }) => {
    const parentOpts = program.opts();
    await pruneCommand({
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('send')
  .argument('[session-id]', 'Session ID to resume (omit with --new)')
  .description('Send a message to an AI session (sync by default, --async for background)')
  .option('-m, --message <text>', 'Message to send (inline)')
  .option('-f, --file <path>', 'Read message from file (e.g. prompt.md)')
  .option('-s, --source <source>', `Tool source — required with --new (${SOURCES})`)
  .option('--new', 'Create a new session instead of resuming')
  .option('--async', 'Run in background and return job ID')
  .option('--cwd <dir>', 'Working directory (default: current)')
  .option('--tokens <n>', 'Token budget for response')
  .option('-p, --preset <name>', `Verbosity preset (${PRESET_NAMES.join(', ')})`, 'standard')
  .action(
    async (
      sessionId: string | undefined,
      opts: {
        message?: string;
        file?: string;
        source?: string;
        new?: boolean;
        async?: boolean;
        cwd?: string;
        tokens?: string;
        preset?: string;
      },
    ) => {
      let message: string;
      if (opts.file && opts.message) {
        process.stderr.write('Error: --message and --file are mutually exclusive\n');
        process.exitCode = 2;
        return;
      }
      if (opts.file) {
        const { readFileSync } = await import('node:fs');
        try {
          message = readFileSync(opts.file, 'utf-8').trim();
        } catch (err) {
          process.stderr.write(`Error: Cannot read file "${opts.file}": ${(err as Error).message}\n`);
          process.exitCode = 2;
          return;
        }
      } else if (opts.message) {
        message = opts.message;
      } else {
        process.stderr.write('Error: Either --message or --file is required\n');
        process.exitCode = 2;
        return;
      }

      const parentOpts = program.opts();
      const sendOpts: SendOptions = {
        message,
        source: opts.source,
        new: opts.new,
        async: opts.async,
        cwd: opts.cwd,
        tokens: opts.tokens ? parseInt(opts.tokens, 10) : undefined,
        preset: opts.preset,
        output: parentOpts.output as OutputFormat | undefined,
      };
      await sendCommand(sessionId, sendOpts);
    },
  );

program
  .command('context', { hidden: true })
  .argument('<session-id>', 'Session ID or prefix')
  .description('Export session context for agent handoff')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--tokens <n>', 'Token budget (default: 8000)')
  .option('--include-system-prompt', 'Include system messages')
  .option('--include-tool-results', 'Include tool results')
  .option('--format <fmt>', 'Output format: messages or summary', 'messages')
  .action(
    async (
      sessionId: string,
      opts: {
        source?: string;
        tokens?: string;
        includeSystemPrompt?: boolean;
        includeToolResults?: boolean;
        format?: string;
      },
    ) => {
      await contextExportCommand(sessionId, {
        source: opts.source,
        tokens: opts.tokens ? parseInt(opts.tokens, 10) : undefined,
        includeSystemPrompt: opts.includeSystemPrompt,
        includeToolResults: opts.includeToolResults,
        format: opts.format as 'messages' | 'summary' | undefined,
      });
    },
  );

// ── Job commands ───────────────────────────────────────────────────────────

program
  .command('jobs', { hidden: true })
  .description('List all async jobs')
  .option('--status <status>', 'Filter by status (running, completed, failed)')
  .action(async (opts: { status?: string }) => {
    const parentOpts = program.opts();
    await jobListCommand({
      output: parentOpts.output as OutputFormat | undefined,
      status: opts.status,
    });
  });

program
  .command('job', { hidden: true })
  .argument('<job-id>', 'Job ID (from sessionr send --async)')
  .description('Check async job status (lazy PID finalization)')
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobStatusCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('wait', { hidden: true })
  .argument('<job-id>', 'Job ID to wait for')
  .description('Block until an async job completes')
  .option('--timeout <seconds>', 'Timeout in seconds', '300')
  .option('--interval <seconds>', 'Poll interval in seconds', '2')
  .action(async (jobId: string, opts: { timeout?: string; interval?: string }) => {
    const parentOpts = program.opts();
    await jobWaitCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
      timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      interval: opts.interval ? parseInt(opts.interval, 10) : undefined,
    });
  });

program
  .command('cancel', { hidden: true })
  .argument('<job-id>', 'Job ID to cancel')
  .description('Cancel a running async job (SIGTERM)')
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobCancelCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

// ── Deprecation aliases (hidden) — old nested forms ────────────────────────

const sessionAlias = program.command('session', { hidden: true });
for (const sub of ['list', 'read', 'stats', 'info', 'search', 'diff', 'tag', 'prune', 'send']) {
  sessionAlias
    .command(`${sub}`, { hidden: true })
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(`Warning: "sessionr session ${sub}" is deprecated, use "sessionr ${sub}"\n`);
      const args = process.argv.filter((a) => a !== 'session');
      program.parse(args);
    });
}

// ── Machine-readable help ──────────────────────────────────────────────────

program.addHelpCommand('help [command]', 'Display help (supports --output json)');

const originalHelp = program.helpInformation.bind(program);
program.helpInformation = function () {
  const parentOpts = program.opts();
  if (parentOpts.output === 'json') {
    return JSON.stringify(buildHelpSchema(program), null, 2);
  }
  return originalHelp();
};

function buildHelpSchema(cmd: Command): Record<string, unknown> {
  const PRIMARY = new Set(['list', 'read', 'send']);
  const mapCmd = (c: Command) => ({
    name: c.name(),
    description: c.description(),
    arguments: (c.registeredArguments ?? []).map((a) => ({
      name: a.name(),
      required: a.required,
      description: a.description,
    })),
    options: c.options.map((o) => ({
      flags: o.flags,
      description: o.description,
      default: o.defaultValue,
    })),
  });

  const allCmds = cmd.commands.filter((c) => c.name() !== 'session');
  const primary = allCmds.filter((c) => PRIMARY.has(c.name())).map(mapCmd);
  const all = allCmds.filter((c) => !(c as unknown as Record<string, boolean>)._hidden || !PRIMARY.has(c.name())).map(mapCmd);

  return {
    api_version: 1,
    version: '2.5.3',
    name: cmd.name(),
    description: cmd.description(),
    sources: SOURCES_LIST,
    workflow: [
      '1. sessionr list — discover sessions',
      '2. sessionr read <id> — read last page (cursor-paginated)',
      '3. Use cursor.prev / cursor.next to page through',
      '4. sessionr send <id> -f prompt.md — resume session',
    ],
    primary_commands: primary,
    all_commands: all,
    exit_codes: { 0: 'ok', 1: 'error', 2: 'bad usage', 3: 'not found', 42: 'no changes (etag)' },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function warnDeprecatedJson(json?: boolean): void {
  if (json) {
    process.stderr.write('Warning: --json is deprecated, use --output json instead\n');
  }
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exitCode = 0;
    } else {
      if (!process.stdout.isTTY) {
        const msg = err.message.replace(/^error:\s*/i, '');
        process.stdout.write(JSON.stringify({
          error: { code: 'USAGE_ERROR', message: msg, retry: false },
        }, null, 2) + '\n');
      }
      process.exitCode = 2;
    }
  } else {
    throw err;
  }
}
