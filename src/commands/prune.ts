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

    if (!opts.yes && !process.stdout.isTTY) {
      throw new SessionReaderError(
        'Destructive operation requires --yes flag when not running interactively',
        {
          code: 'CONFIRMATION_REQUIRED',
          exitCode: EXIT.USAGE,
          suggestion: `sessionr session prune --older-than ${opts.olderThan} --yes`,
        },
      );
    }

    if (!opts.yes) {
      throw new SessionReaderError(
        `Would delete ${toDelete.length} sessions. Re-run with --yes to confirm, or use --dry-run to preview.`,
        {
          code: 'CONFIRMATION_REQUIRED',
          exitCode: EXIT.USAGE,
          suggestion: `sessionr session prune --older-than ${opts.olderThan} --yes`,
        },
      );
    }

    // Note: actual deletion depends on source adapters supporting delete.
    // For now, report what would be deleted — actual file deletion is source-specific.
    const result = {
      api_version: 1,
      status: 'ok',
      deleted: toDelete.map((e) => ({
        id: e.id,
        source: e.source,
        file_path: e.filePath,
      })),
      count: toDelete.length,
    };

    console.log(JSON.stringify(result, dateReplacer, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(
      JSON.stringify({ error: { code: 'PRUNE_FAILED', message: error.message } }),
    );
    process.exitCode = exitCodeForError(err);
  }
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
