import { listSessions } from '../discovery.js';
import { exitCodeForError, SessionReaderError, EXIT } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(d|h|m|s)$/);
  if (!match) {
    throw new SessionReaderError(`Invalid duration: "${duration}". Use format like 7d, 24h, 30m`, {
      code: 'INVALID_DURATION',
      exitCode: EXIT.USAGE,
    });
  }
  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new SessionReaderError('Duration must be greater than 0', {
      code: 'INVALID_DURATION',
      exitCode: EXIT.USAGE,
      suggestion: 'sessionr prune --older-than 7d --dry-run',
    });
  }

  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return value * multipliers[unit];
}

export async function pruneCommand(
  opts: {
    olderThan: string;
    dryRun?: boolean;
    yes?: boolean;
    source?: string;
    json?: boolean;
    output?: OutputFormat;
  },
): Promise<void> {
  try {
    const durationMs = parseDuration(opts.olderThan);
    const cutoff = new Date(Date.now() - durationMs);

    if (!opts.dryRun && opts.yes) {
      throw new SessionReaderError(
        'prune --yes is not yet implemented; use --dry-run to preview sessions that would be deleted',
        {
          code: 'NOT_IMPLEMENTED',
          exitCode: EXIT.ERROR,
          suggestion: `sessionr prune --older-than ${opts.olderThan} --dry-run`,
        },
      );
    }

    const entries = await listSessions(opts.source as SessionSource | undefined);
    const toDelete = entries.filter((e) => e.updatedAt < cutoff);

    if (opts.dryRun) {
      const result = {
        api_version: 1,
        dry_run: true,
        would_delete: toDelete.map((e) => ({
          id: e.id,
          source: e.source,
          updated_at: e.updatedAt,
          cwd: e.cwd,
        })),
        count: toDelete.length,
      };
      console.log(JSON.stringify(result, dateReplacer, 2));
      return;
    }

    if (!process.stdout.isTTY) {
      throw new SessionReaderError(
        'Destructive operation requires --yes flag when not running interactively',
        {
          code: 'CONFIRMATION_REQUIRED',
          exitCode: EXIT.USAGE,
          suggestion: `sessionr prune --older-than ${opts.olderThan} --yes`,
        },
      );
    }

    if (!opts.yes) {
      throw new SessionReaderError(
        `Would delete ${toDelete.length} sessions. Re-run with --yes to confirm, or use --dry-run to preview.`,
        {
          code: 'CONFIRMATION_REQUIRED',
          exitCode: EXIT.USAGE,
          suggestion: `sessionr prune --older-than ${opts.olderThan} --yes`,
        },
      );
    }
  } catch (err) {
    const writeError = isStructuredOutput(opts) ? console.log : console.error;
    if (err instanceof SessionReaderError) {
      writeError(JSON.stringify({ error: err.toJSON() }, null, 2));
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      writeError(JSON.stringify({ error: { code: 'PRUNE_FAILED', message: error.message, retry: false } }, null, 2));
    }
    process.exitCode = exitCodeForError(err);
  }
}

function isStructuredOutput(opts: { json?: boolean; output?: OutputFormat }): boolean {
  return opts.output === 'json' || opts.output === 'jsonl' || opts.json === true;
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
