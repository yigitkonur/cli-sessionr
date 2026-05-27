import { cmdPrefix } from '../util/invocation.js';
import { listSessions } from '../discovery.js';
import { exitCodeForError, SessionReaderError, EXIT } from '../errors.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import type { SessionSource, OutputFormat } from '../types.js';

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(d|h|m|s)$/);
  if (!match) {
    throw new SessionReaderError(`Invalid duration: "${duration}". Use format like 7d, 24h, 30m`, {
      code: 'INVALID_DURATION',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
    });
  }
  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new SessionReaderError('Duration must be greater than 0', {
      code: 'INVALID_DURATION',
      errorClass: 'validation',
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

/**
 * Prune sessions older than a threshold.
 *
 * v3.0 NOTE: Real deletion is intentionally NOT implemented. The
 * `--dry-run` path returns a v2 success envelope previewing what would
 * be deleted; `--yes` (or any code path that would actually delete)
 * refuses with `NOT_IMPLEMENTED` so the success envelope never lies
 * about destructive action. Real deletion is planned for v3.1.0.
 */
export async function pruneCommand(
  opts: {
    olderThan: string;
    dryRun?: boolean;
    yes?: boolean;
    source?: string;
    json?: boolean;
    output?: OutputFormat;
    timing?: boolean;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat =
    opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));

  try {
    const durationMs = parseDuration(opts.olderThan);
    const cutoff = new Date(Date.now() - durationMs);

    // Interim refuse path: v3.0 ships dry-run only. Any caller asking for
    // real deletion gets a hard refusal so the success envelope never
    // misrepresents reality (the "01-CRITICAL-prune-yes-fakes-deletion" bug).
    if (opts.yes && !opts.dryRun) {
      throw new SessionReaderError(
        'Real deletion not implemented yet; use --dry-run to preview',
        {
          code: 'NOT_IMPLEMENTED',
          errorClass: 'internal',
          exitCode: EXIT.ERROR,
          detail: { feature: 'prune --yes', planned_in: 'v3.1.0' },
          suggestion: 'sessionr prune --dry-run --output json',
          retry: false,
        },
      );
    }

    const entries = await listSessions(opts.source as SessionSource | undefined);
    const toDelete = entries.filter((e) => e.updatedAt < cutoff);

    if (opts.dryRun) {
      const result = {
        dry_run: true,
        would_delete: toDelete.map((e) => ({
          id: e.id,
          source: e.source,
          updated_at: e.updatedAt.toISOString(),
          cwd: e.cwd,
        })),
        count: toDelete.length,
      };

      if (outputFormat === 'json' || outputFormat === 'jsonl') {
        emit(
          success(result, {
            meta: {
              cwd: process.cwd(),
              older_than: opts.olderThan,
              cutoff: cutoff.toISOString(),
            },
            actions: [
              {
                command: `${cmdPrefix()} prune --older-than ${opts.olderThan} --yes`,
                description: 'Actually delete the sessions above (NOT_IMPLEMENTED in v3.0)',
              },
            ],
          }),
          { format: outputFormat, timing: opts.timing },
        );
      } else {
        process.stdout.write(
          `Would delete ${toDelete.length} sessions older than ${opts.olderThan} (cutoff: ${cutoff.toISOString()}).\n`,
        );
        for (const e of toDelete) {
          process.stdout.write(`  ${e.id}  ${e.source}  ${e.cwd}\n`);
        }
      }
      return;
    }

    // No --dry-run and no --yes: classic confirmation-required usage error.
    if (!isTTY) {
      throw new SessionReaderError(
        'Destructive operation requires --yes flag when not running interactively',
        {
          code: 'CONFIRMATION_REQUIRED',
          errorClass: 'validation',
          exitCode: EXIT.USAGE,
          suggestion: `${cmdPrefix()} prune --older-than ${opts.olderThan} --yes`,
        },
      );
    }

    throw new SessionReaderError(
      `Would delete ${toDelete.length} sessions. Re-run with --yes to confirm, or use --dry-run to preview.`,
      {
        code: 'CONFIRMATION_REQUIRED',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        suggestion: `${cmdPrefix()} prune --older-than ${opts.olderThan} --yes`,
      },
    );
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'PRUNE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(error.message + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}
