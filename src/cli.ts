#!/usr/bin/env node
import { Command } from 'commander';
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

const program = new Command();

program
  .name('sessionr')
  .description('Read and inspect AI coding sessions from Codex CLI, Claude Code, and more')
  .version('2.0.0')
  .option('--output <format>', 'Output format: json, jsonl, table, text')
  .option('--api-version <n>', 'API version for structured output', '1');

// ── session subcommand group ───────────────────────────────────────────────

const session = program
  .command('session')
  .description('Session operations');

session
  .command('list [source]')
  .description('List available sessions')
  .option('-n, --limit <n>', 'Max sessions to list', '20')
  .option('--json', '[deprecated] Use --output json')
  .action(async (source: string | undefined, opts: { limit?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await listCommand(source, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('read <session-id> [from] [to]')
  .description('Read session messages with token-aware pagination')
  .option('-s, --source <source>', 'Filter by source')
  .option('-p, --preset <name>', `Verbosity preset (${PRESET_NAMES.join(', ')})`, 'standard')
  .option('-d, --detail <level>', `Detail level (${DETAIL_LEVELS.join(', ')})`)
  .option('--tokens <n>', 'Token budget (env: SESSIONREADER_MAX_TOKENS)')
  .option('--anchor <anchor>', 'Slice anchor: head, tail, search', 'tail')
  .option('--search <query>', 'Search query (sets anchor=search)')
  .option('--role <roles>', 'Filter by role (comma-separated)')
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
        before: opts.before ? parseInt(opts.before as string, 10) : undefined,
        after: opts.after ? parseInt(opts.after as string, 10) : undefined,
        ifChanged: opts.ifChanged as string | undefined,
      };

      // ETag check
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

session
  .command('stats <session-id>')
  .description('Show session statistics')
  .option('-s, --source <source>', 'Filter by source')
  .option('--json', '[deprecated] Use --output json')
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await statsCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('info <session-id>')
  .description('Show session metadata (lightweight stats)')
  .option('-s, --source <source>', 'Filter by source')
  .option('--json', '[deprecated] Use --output json')
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await infoCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('search')
  .description('Search across sessions by content')
  .requiredOption('-q, --query <text>', 'Search query')
  .option('-s, --source <source>', 'Filter by source')
  .option('--top <n>', 'Max results to return', '10')
  .option('--json', '[deprecated] Use --output json')
  .action(async (opts: { query: string; source?: string; top?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await searchCommand({
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('diff <id1> <id2>')
  .description('Compare two sessions (structural diff)')
  .option('-s, --source <source>', 'Filter by source')
  .option('--json', '[deprecated] Use --output json')
  .action(async (id1: string, id2: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await diffCommand(id1, id2, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('tag <session-id>')
  .description('Add or remove session tags (idempotent)')
  .option('--add <tag>', 'Tag to add')
  .option('--remove <tag>', 'Tag to remove')
  .option('-s, --source <source>', 'Filter by source')
  .action(async (sessionId: string, opts: { add?: string; remove?: string; source?: string }) => {
    const parentOpts = program.opts();
    await tagCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('prune')
  .description('Delete old sessions')
  .requiredOption('--older-than <duration>', 'Duration threshold (e.g., 7d, 24h)')
  .option('--dry-run', 'Preview what would be deleted')
  .option('--yes', 'Skip confirmation')
  .option('-s, --source <source>', 'Filter by source')
  .action(async (opts: { olderThan: string; dryRun?: boolean; yes?: boolean; source?: string }) => {
    const parentOpts = program.opts();
    await pruneCommand({
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

session
  .command('send [session-id]')
  .description('Send a message to an AI session (sync by default, --async for background)')
  .requiredOption('-m, --message <text>', 'Message to send')
  .option('-s, --source <source>', 'Tool source (required with --new)')
  .option('--new', 'Create a new session instead of resuming')
  .option('--async', 'Run in background and return job ID')
  .option('--cwd <dir>', 'Working directory (default: current)')
  .option('--tokens <n>', 'Token budget for response')
  .option('-p, --preset <name>', `Verbosity preset (${PRESET_NAMES.join(', ')})`, 'standard')
  .action(
    async (
      sessionId: string | undefined,
      opts: {
        message: string;
        source?: string;
        new?: boolean;
        async?: boolean;
        cwd?: string;
        tokens?: string;
        preset?: string;
      },
    ) => {
      const parentOpts = program.opts();
      const sendOpts: SendOptions = {
        message: opts.message,
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

// ── job subcommand group ───────────────────────────────────────────────────

const job = program
  .command('job')
  .description('Manage async send jobs');

job
  .command('status <job-id>')
  .description('Check job status (lazy PID finalization)')
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobStatusCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

job
  .command('wait <job-id>')
  .description('Block until job completes')
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

job
  .command('cancel <job-id>')
  .description('Cancel a running job (SIGTERM)')
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobCancelCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

job
  .command('list')
  .description('List all jobs')
  .option('--status <status>', 'Filter by status (running, completed, failed)')
  .action(async (opts: { status?: string }) => {
    const parentOpts = program.opts();
    await jobListCommand({
      output: parentOpts.output as OutputFormat | undefined,
      status: opts.status,
    });
  });

// ── context subcommand group ───────────────────────────────────────────────

const context = program
  .command('context')
  .description('Context operations for agent-to-agent handoff');

context
  .command('export <session-id>')
  .description('Export session context for agent consumption')
  .option('-s, --source <source>', 'Filter by source')
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

// ── Deprecation aliases (hidden) ───────────────────────────────────────────

program
  .command('list [source]', { hidden: true })
  .option('-n, --limit <n>', 'Max sessions to list', '20')
  .option('--json', 'Output as JSON')
  .action(async (source: string | undefined, opts: { limit?: string; json?: boolean }) => {
    process.stderr.write(
      'Warning: "sessionr list" is deprecated, use "sessionr session list"\n',
    );
    const parentOpts = program.opts();
    await listCommand(source, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('read <session-id> [from] [to]', { hidden: true })
  .option('-s, --source <source>', 'Filter by source')
  .option('-p, --preset <name>', `Verbosity preset (${PRESET_NAMES.join(', ')})`, 'standard')
  .option('--json', 'Output as JSON')
  .action(
    async (
      sessionId: string,
      from: string | undefined,
      to: string | undefined,
      opts: { source?: string; preset?: string; json?: boolean },
    ) => {
      process.stderr.write(
        'Warning: "sessionr read" is deprecated, use "sessionr session read"\n',
      );
      const parentOpts = program.opts();
      await readCommand(sessionId, from, to, {
        ...opts,
        output: parentOpts.output as OutputFormat | undefined,
      });
    },
  );

program
  .command('stats <session-id>', { hidden: true })
  .option('-s, --source <source>', 'Filter by source')
  .option('--json', 'Output as JSON')
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    process.stderr.write(
      'Warning: "sessionr stats" is deprecated, use "sessionr session stats"\n',
    );
    const parentOpts = program.opts();
    await statsCommand(sessionId, {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

// ── Machine-readable help ──────────────────────────────────────────────────

program.addHelpCommand('help [command]', 'Display help (supports --output json)');

// Override help display when --output json is requested
const originalHelp = program.helpInformation.bind(program);
program.helpInformation = function () {
  const parentOpts = program.opts();
  if (parentOpts.output === 'json') {
    return JSON.stringify(buildHelpSchema(program), null, 2);
  }
  return originalHelp();
};

function buildHelpSchema(cmd: Command): Record<string, unknown> {
  return {
    api_version: 1,
    name: cmd.name(),
    description: cmd.description(),
    commands: cmd.commands
      .filter((c) => !(c as unknown as Record<string, boolean>)._hidden)
      .map((c) => ({
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
        subcommands: c.commands.length > 0 ? buildHelpSchema(c).commands : undefined,
      })),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function warnDeprecatedJson(json?: boolean): void {
  if (json) {
    process.stderr.write(
      'Warning: --json is deprecated, use --output json instead\n',
    );
  }
}

program.parse();
