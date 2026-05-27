#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { doctorCommand } from './commands/doctor.js';
import { jobStatusCommand, jobWaitCommand, jobCancelCommand, jobListCommand } from './commands/job.js';
import { PRESET_NAMES, DETAIL_LEVELS } from './config.js';
import { SessionReaderError, EXIT, exitCodeForError } from './errors.js';
import { parseBounded, resolveSource, SOURCES_LIST } from './utils/validate.js';
import { markStart } from './output/emit.js';
import { success } from './output/envelope.js';
import type { OutputFormat, DetailLevel, ReadOptions, SendOptions } from './types.js';

// Anchor --timing measurements at CLI boot. The emit() helper reads from this
// when callers pass {timing: true}; harmless no-op if --timing is never set.
markStart();

// Read version from package.json at module init so semantic-release bumps propagate
// without code changes. dist/cli.js lives at <pkg>/dist/cli.js so ../package.json resolves.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }).version;

const SOURCES = 'claude, codex, gemini, copilot, cursor-agent, commandcode, goose, opencode, kiro, zed, factory (alias: droid)';
const PRESET_HELP = `Verbosity preset (${PRESET_NAMES.join(', ')}; minimal ~200 tokens, standard ~600 tokens, verbose ~1500 tokens, full ~3000+ tokens) [default: verbose for agents, standard for TTY]`;
const SEND_PRESET_HELP = `Verbosity preset (${PRESET_NAMES.join(', ')}; minimal ~200 tokens, standard ~600 tokens, verbose ~1500 tokens, full ~3000+ tokens)`;
const TOP_LEVEL_HELP_AFTER = `
Examples:
  $ sessionr list                               # recent sessions
  $ sessionr read <id> --anchor tail            # read the latest messages
  $ sessionr send <id> -f prompt.md --async     # resume in the background
  $ sessionr --output json help | jq '.workflow'

Exit codes
  0   Success
  1   Internal error
  2   Bad usage / validation
  3   Session/job/resource not found
  4   Authentication required (reserved)
  5   Rate-limited / transient (reserved)
  10  Partial result (truncated by token budget)
  42  No changes (--if-changed match)`;

const program = new Command();

program
  .name('sessionr')
  .description(`sessionr v${PKG_VERSION} — read, send, and orchestrate AI coding sessions`)
  .version(PKG_VERSION)
  .option('--output <format>', 'Output format: json, jsonl, table, text')
  .option('--api-version <n>', 'API version for structured output', '1')
  .option('--timing', 'Include timing_ms in JSON responses');

// --api-version gate: only legacy "1" and new "2" are accepted. Anything else
// throws a structured SessionReaderError so the bottom-of-file catch block
// emits a v2-shaped error envelope and exits 2.
const VALID_API_VERSIONS = new Set(['1', '2']);
program.hook('preAction', (thisCmd) => {
  const apiVersion = thisCmd.opts().apiVersion as string | undefined;
  if (apiVersion !== undefined && !VALID_API_VERSIONS.has(apiVersion)) {
    throw new SessionReaderError(
      `Invalid --api-version "${apiVersion}"; expected one of: 1, 2`,
      {
        code: 'INVALID_API_VERSION',
        exitCode: EXIT.USAGE,
        detail: { provided: apiVersion, accepted: ['1', '2'] },
        suggestion: 'Pass --api-version 2 for the v3 envelope shape.',
        retry: false,
        errorClass: 'validation',
      },
    );
  }
});

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
  .option('--cwd <mode>', 'Filter by cwd: auto | current | all | <path>', 'auto')
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr list                               # recent sessions
  $ sessionr list claude -n 5                   # 5 most recent Claude sessions
  $ sessionr list -q "deploy script"            # search across recent sessions
  $ sessionr list --output json | jq '.sessions[].id'`)
  .action(async (source: string | undefined, opts: { limit?: string; offset?: string; search?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await listCommand(resolveSource(source), {
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
    });
  });

program
  .command('doctor')
  .description('Diagnose session source setup')
  .option('--json', '[deprecated] Use --output json')
  .action(async (opts: { json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await doctorCommand({
      ...opts,
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('read')
  .argument('[session-id]', 'Session ID or prefix (use "sessionr list" to find)')
  .argument('[from]', 'Start message index (1-based)')
  .argument('[to]', 'End message index (1-based)')
  .description('Read session messages with token-aware pagination')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('-p, --preset <name>', PRESET_HELP)
  .option('-d, --detail <level>', `Detail level (${DETAIL_LEVELS.join(', ')})`)
  .option('--tokens <n>', 'Token budget (env: SESSIONREADER_MAX_TOKENS)')
  .option('--anchor <anchor>', 'Slice anchor: head, tail, search', 'head')
  .option('--search <query>', 'Search query (sets anchor=search)')
  .option('--role <roles>', 'Filter by role (comma-separated: user, assistant, system, tool_use, tool_result)')
  .option('--page <n>', 'Page number (1-based, from head)')
  .option('--before <cursor>', 'Cursor: show messages before this index')
  .option('--after <cursor>', 'Cursor: show messages after this index')
  .option('--if-changed <etag>', 'Only return data if changed since ETag')
  .option('--include-summary', 'Include session summary even after page 1')
  .option('--batch <path>', 'Read newline-separated session IDs as streaming JSONL')
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr read 8e46722b                      # head of session, default token budget
  $ sessionr read 8e46722b --anchor tail        # latest messages
  $ sessionr read 8e46722b --search "error"     # window around first match
  $ sessionr read 8e46722b --page 2 --tokens 4000
  $ sessionr read 8e46722b --if-changed <etag>  # 304-style polling`)
  .action(
    async (
      sessionId: string | undefined,
      from: string | undefined,
      to: string | undefined,
      opts: Record<string, string | boolean | undefined>,
    ) => {
      warnDeprecatedJson(opts.json as boolean | undefined);
      const parentOpts = program.opts();
      const source = resolveSource(opts.source as string | undefined);
      const readOpts: ReadOptions = {
        source,
        preset: opts.preset as string | undefined,
        detail: opts.detail as DetailLevel | undefined,
        json: opts.json as boolean | undefined,
        output: parentOpts.output as OutputFormat | undefined,
        tokens: parseOptionalBounded('--tokens', opts.tokens, 1),
        anchor: opts.anchor as 'head' | 'tail' | 'search' | undefined,
        search: opts.search as string | undefined,
        role: opts.role as string | undefined,
        page: parseOptionalBounded('--page', opts.page, 1),
        before: parseOptionalBounded('--before', opts.before, 1),
        after: parseOptionalBounded('--after', opts.after, 1),
        ifChanged: opts.ifChanged as string | undefined,
        includeSummary: opts.includeSummary as boolean | undefined,
        batch: opts.batch as string | undefined,
      };

      if (!sessionId && !readOpts.batch) {
        process.stderr.write('Error: <session-id> is required unless --batch is provided\n');
        process.exitCode = 2;
        return;
      }

      if (readOpts.ifChanged && sessionId) {
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

      // Forward parent --timing into read so meta.timing_ms appears in the
      // v2 envelope. Phase 1 carry-forward.
      readOpts.timing = Boolean(parentOpts.timing);
      await readCommand(sessionId ?? '', from, to, readOpts);
    },
  );

program
  .command('stats')
  .argument('<session-id>', 'Session ID or prefix')
  .description('Show full session statistics')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr stats 8e46722b                     # tools, files, duration
  $ sessionr stats 8e46722b -s codex            # disambiguate by source
  $ sessionr stats 8e46722b --output json       # structured stats`)
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await statsCommand(sessionId, {
      ...opts,
      source: resolveSource(opts.source),
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('info')
  .argument('<session-id>', 'Session ID or prefix')
  .description('Show lightweight session metadata (cheaper than stats)')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr info 8e46722b                      # cheap session metadata
  $ sessionr info 8e46722b -s claude            # disambiguate by source
  $ sessionr info 8e46722b --output json        # structured metadata`)
  .action(async (sessionId: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await infoCommand(sessionId, {
      ...opts,
      source: resolveSource(opts.source),
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('search')
  .description('Search across sessions by content')
  .requiredOption('-q, --query <text>', 'Search query')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--top <n>', 'Max results to return', '10')
  .option('--max-sessions <n>', 'Max sessions to scan (most recent first)', '20')
  .option('--cwd <mode>', 'Filter by cwd: auto | current | all | <path>', 'auto')
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr search -q "deploy failed"          # search recent sessions
  $ sessionr search -q "etag" --top 5           # limit matches
  $ sessionr search -q "auth" -s codex          # search one source
  $ sessionr search -q "build" --output json`)
  .action(async (opts: { query: string; source?: string; top?: string; maxSessions?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await searchCommand({
      ...opts,
      source: resolveSource(opts.source),
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('diff')
  .argument('<id1>', 'First session ID or prefix')
  .argument('<id2>', 'Second session ID or prefix')
  .description('Compare two sessions (structural diff)')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--json', '[deprecated] Use --output json')
  .addHelpText('after', `
Examples:
  $ sessionr diff 8e46722b 9f8123aa             # compare two sessions
  $ sessionr diff old new -s claude             # disambiguate by source
  $ sessionr diff old new --output json         # structured diff`)
  .action(async (id1: string, id2: string, opts: { source?: string; json?: boolean }) => {
    warnDeprecatedJson(opts.json);
    const parentOpts = program.opts();
    await diffCommand(id1, id2, {
      ...opts,
      source: resolveSource(opts.source),
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('tag')
  .argument('<session-id>', 'Session ID or prefix')
  .description('Add or remove session tags (idempotent)')
  .option('--add <tag>', 'Tag to add')
  .option('--remove <tag>', 'Tag to remove')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .addHelpText('after', `
Examples:
  $ sessionr tag 8e46722b --add review          # add a tag
  $ sessionr tag 8e46722b --remove stale        # remove a tag
  $ sessionr tag 8e46722b --add rescue -s codex # disambiguate by source`)
  .action(async (sessionId: string, opts: { add?: string; remove?: string; source?: string }) => {
    const parentOpts = program.opts();
    await tagCommand(sessionId, {
      ...opts,
      source: resolveSource(opts.source),
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('prune')
  .description('Delete old sessions')
  .requiredOption('--older-than <duration>', 'Duration threshold (e.g., 7d, 24h)')
  .option('--dry-run', 'Preview what would be deleted')
  .option('--yes', 'Skip confirmation')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .addHelpText('after', `
Examples:
  $ sessionr prune --older-than 30d --dry-run   # preview deletions
  $ sessionr prune --older-than 7d -s codex     # prune one source
  $ sessionr prune --older-than 90d --yes       # delete without prompt`)
  .action(async (opts: { olderThan: string; dryRun?: boolean; yes?: boolean; source?: string }) => {
    const parentOpts = program.opts();
    await pruneCommand({
      ...opts,
      source: resolveSource(opts.source),
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
  .option('-p, --preset <name>', SEND_PRESET_HELP, 'standard')
  .addHelpText('after', `
Examples:
  $ sessionr send 8e46722b -m "follow up"       # resume sync
  $ sessionr send 8e46722b -f prompt.md         # resume from file
  $ sessionr send --new -s claude -f prompt.md  # new session
  $ sessionr send 8e46722b -m "go" --async      # background job`)
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
      // oc/05: pass message + file through unvalidated. sendCommand resolves
      // them AFTER the formatter is initialised so JSON callers get a v2
      // envelope on stdout instead of raw text on stderr.
      const parentOpts = program.opts();
      const sendOpts: SendOptions = {
        message: opts.message,
        file: opts.file,
        source: resolveSource(opts.source),
        new: opts.new,
        async: opts.async,
        cwd: opts.cwd,
        tokens: parseOptionalBounded('--tokens', opts.tokens, 1),
        preset: opts.preset,
        output: parentOpts.output as OutputFormat | undefined,
      };
      await sendCommand(sessionId, sendOpts);
    },
  );

program
  .command('context')
  .argument('<session-id>', 'Session ID or prefix')
  .description('Export session context for agent handoff')
  .option('-s, --source <source>', `Filter by source (${SOURCES})`)
  .option('--tokens <n>', 'Token budget (default: 8000)')
  .option('--include-system-prompt', 'Include system messages')
  .option('--include-tool-results', 'Include tool results')
  .option('--format <fmt>', 'Output format: messages or summary', 'messages')
  .addHelpText('after', `
Examples:
  $ sessionr context 8e46722b --tokens 8000     # export handoff context
  $ sessionr context 8e46722b --format summary  # compact summary
  $ sessionr context 8e46722b --include-tool-results`)
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
      const parentOpts = program.opts();
      await contextExportCommand(sessionId, {
        source: resolveSource(opts.source),
        tokens: parseOptionalBounded('--tokens', opts.tokens, 1),
        includeSystemPrompt: opts.includeSystemPrompt,
        includeToolResults: opts.includeToolResults,
        format: opts.format as 'messages' | 'summary' | undefined,
        output: parentOpts.output as OutputFormat | undefined,
        timing: Boolean(parentOpts.timing),
      });
    },
  );

// ── Job commands ───────────────────────────────────────────────────────────

program
  .command('jobs')
  .description('List all async jobs')
  .option('--status <status>', 'Filter by status (running, completed, failed)')
  .addHelpText('after', `
Examples:
  $ sessionr jobs                               # list all jobs
  $ sessionr jobs --status running              # running jobs only
  $ sessionr jobs --output json                 # structured job list`)
  .action(async (opts: { status?: string }) => {
    const parentOpts = program.opts();
    await jobListCommand({
      output: parentOpts.output as OutputFormat | undefined,
      status: opts.status,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('job')
  .argument('<job-id>', 'Job ID (from sessionr send --async)')
  .description('Check async job status (lazy PID finalization)')
  .addHelpText('after', `
Examples:
  $ sessionr job job_abc123                     # check status
  $ sessionr job job_abc123 --output json       # structured status
  $ sessionr wait job_abc123                    # wait until done`)
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobStatusCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('wait')
  .argument('<job-id>', 'Job ID to wait for')
  .description('Block until an async job completes')
  .option('--timeout <seconds>', 'Timeout in seconds', '300')
  .option('--interval <seconds>', 'Poll interval in seconds', '2')
  .addHelpText('after', `
Examples:
  $ sessionr wait job_abc123                    # wait up to 5 minutes
  $ sessionr wait job_abc123 --timeout 60       # shorter timeout
  $ sessionr wait job_abc123 --interval 5       # slower polling`)
  .action(async (jobId: string, opts: { timeout?: string; interval?: string }) => {
    const parentOpts = program.opts();
    await jobWaitCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
      timeout: parseOptionalBounded('--timeout', opts.timeout, 1),
      interval: parseOptionalBounded('--interval', opts.interval, 1),
      timing: Boolean(parentOpts.timing),
    });
  });

program
  .command('cancel')
  .argument('<job-id>', 'Job ID to cancel')
  .description('Cancel a running async job (SIGTERM)')
  .addHelpText('after', `
Examples:
  $ sessionr cancel job_abc123                  # cancel a running job
  $ sessionr job job_abc123                     # confirm final status
  $ sessionr jobs --status failed               # inspect failed jobs`)
  .action(async (jobId: string) => {
    const parentOpts = program.opts();
    await jobCancelCommand(jobId, {
      output: parentOpts.output as OutputFormat | undefined,
      timing: Boolean(parentOpts.timing),
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
    // oc/06: emit a v2 envelope (ok:true, schema_version:'v2', result:{…})
    // so `sessionr --output json help` matches the same shape every other
    // command produces. Commander writes this string to stdout and then
    // throws `commander.helpDisplayed`, which the top-level catch maps to
    // exitCode = 0 — so the previous "exit 2 + raw schema" behaviour is
    // gone for good. Returning a string keeps Commander's helpInformation
    // contract intact; the string already includes its trailing newline
    // via JSON.stringify-and-emit semantics below.
    return JSON.stringify(success(buildHelpSchema(program)));
  }
  return originalHelp() + TOP_LEVEL_HELP_AFTER;
};

function buildHelpSchema(cmd: Command): Record<string, unknown> {
  const PRIMARY = new Set(['list', 'read', 'send', 'doctor']);
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
    version: PKG_VERSION,
    name: cmd.name(),
    description: cmd.description(),
    sources: SOURCES_LIST,
    workflow: [
      '1. sessionr list — discover recent sessions',
      '2. sessionr info <id> — cheap metadata (size, message counts, model)',
      '3. sessionr read <id> --tokens 4000 — first page (head); use --anchor tail for the most recent turn',
      '4. Page with cursor.next / cursor.prev or --page N',
      '5. sessionr stats <id> — full stats: tools, files modified, durations',
      '6. sessionr search -q "<text>" — find sessions by content',
      '7. sessionr send <id> -f prompt.md — resume the session synchronously',
      '8. sessionr send <id> -f prompt.md --async → sessionr wait <job-id> → sessionr read <id> --after N — long-running flows',
      '9. sessionr context <id> --tokens 8000 — export for cross-tool handoff',
    ],
    // `commands` is the canonical full list (covered by the acceptance probe);
    // `primary_commands` / `all_commands` are kept for backward compat with
    // any agent that already keys off the legacy field names.
    commands: all,
    primary_commands: primary,
    all_commands: all,
    exit_codes: {
      0: 'ok',
      1: 'internal error',
      2: 'bad usage / validation',
      3: 'session/job/resource not found',
      4: 'authentication required (reserved)',
      5: 'rate-limited / transient (reserved)',
      10: 'partial result (truncated by token budget)',
      42: 'no changes (--if-changed match)',
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function warnDeprecatedJson(json?: boolean): void {
  if (json) {
    process.stderr.write('Warning: --json is deprecated, use --output json instead\n');
  }
}

function parseOptionalBounded(name: string, raw: unknown, min: number, max?: number): number | undefined {
  if (raw == null) return undefined;
  return parseBounded(name, raw as string, 0, min, max);
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    const successfulCommanderExits = new Set([
      'commander.help',
      'commander.helpDisplayed',
      'commander.version',
    ]);
    if (successfulCommanderExits.has(err.code)) {
      process.exitCode = 0;
    } else {
      // oc/08 + oc/09 carry-forward: argparse failures must emit the same
      // v2 envelope shape every other path produces, on stdout, so callers
      // can branch on `.ok === false` uniformly without `2>&1` plumbing.
      const parentOpts = program.opts();
      const format = (parentOpts.output as OutputFormat | undefined) ?? 'json';
      const msg = err.message.replace(/^error:\s*/i, '');
      const { failure } = await import('./output/envelope.js');
      const { emit } = await import('./output/emit.js');
      emit(
        failure({
          class: 'validation',
          code: 'USAGE_ERROR',
          message: msg,
          retryable: false,
        }),
        { format, timing: Boolean(parentOpts.timing) },
      );
      process.exitCode = 2;
    }
  } else if (err instanceof SessionReaderError) {
    // v2 envelope routing (oc/04): error envelopes go to stdout in JSON mode
    // so downstream pipelines can read .ok === false uniformly. Phase 0 only
    // routes errors raised at the top-level (e.g. INVALID_API_VERSION from
    // the preAction hook); per-command paths migrate in Phase 2.
    const parentOpts = program.opts();
    const format = (parentOpts.output as OutputFormat | undefined) ?? 'json';
    const { failure } = await import('./output/envelope.js');
    const { emit } = await import('./output/emit.js');
    emit(
      failure({
        class: err.class,
        code: err.code,
        message: err.message,
        ...(Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
        ...(err.suggestion ? { suggestion: err.suggestion } : {}),
        retryable: err.retry,
      }),
      { format, timing: Boolean(parentOpts.timing) },
    );
    process.exitCode = exitCodeForError(err);
  } else {
    throw err;
  }
}
