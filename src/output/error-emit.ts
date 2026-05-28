// Shared v2 failure-envelope emitter for command catch blocks.
//
// Phase 2 quality review flagged that 11 commands (info, stats, search, diff,
// tag, prune, context, read, jobs, job, wait, cancel) ship the same 12-line
// catch sequence: wrap any thrown value in a SessionReaderError-aware
// V2Error, route through emit(failure(...)), then set process.exitCode via
// exitCodeForError. Duplicating that shape across 11 files makes it trivial
// for the envelope to drift between commands (forget the `class` field
// here, forget `retryable` there) — the exact regression that triggered
// oc/07 + oc/09 in Phase 1.
//
// This module promotes the helper that already lived inside src/commands/
// job.ts into a single, shared location so every command catch block can
// collapse to:
//
//   } catch (err) {
//     emitError(err, { format: outputFormat, timing: opts.timing,
//                      fallbackCode: 'STATS_FAILED' });
//   }
//
// Contract (intentionally narrow):
//   - Always emits a v2 failure envelope on stdout via emit().
//   - Always sets process.exitCode via exitCodeForError(err).
//   - Picks `class`/`code`/`detail`/`suggestion`/`retryable` from the error
//     when it's a SessionReaderError, otherwise falls back to
//     class='internal' + the caller-supplied fallbackCode.
//   - Carries `--timing` through so meta.timing_ms appears uniformly.
//
// What it does NOT do:
//   - Format human-readable text (TTY/plain) errors. Those still belong in
//     individual commands because the prose tends to be command-specific.
//     For json/jsonl mode (the agent contract), this helper is the only
//     thing a catch block needs.

import { SessionReaderError, exitCodeForError } from '../errors.js';
import type { OutputFormat } from '../types.js';
import { emit } from './emit.js';
import { failure } from './envelope.js';

export interface EmitErrorOpts {
  /** Output format for routing — only json/jsonl emit through here today. */
  format: OutputFormat;
  /** Forward --timing so meta.timing_ms surfaces on error envelopes too. */
  timing?: boolean;
  /** Code to use when the thrown value is NOT a SessionReaderError. */
  fallbackCode: string;
}

/**
 * Emit a v2 failure envelope for `err` and set process.exitCode.
 *
 * Behaves identically to the legacy in-command catch blocks the codebase
 * shipped before this helper landed — promoting the shape into one place
 * means every command surfaces the same `class`/`code`/`retryable`/
 * `detail`/`suggestion` fields without per-file drift.
 *
 * Callers that still need a TTY error string can keep their own
 * formatter.error() write before/after calling this; we don't lock that
 * out, but if you can, prefer routing the human path through
 * createFormatter().error() and letting this helper own the structured
 * channel.
 */
export function emitError(err: unknown, opts: EmitErrorOpts): void {
  const isSre = err instanceof SessionReaderError;
  emit(
    failure({
      class: isSre ? err.class : 'internal',
      code: isSre ? err.code : opts.fallbackCode,
      message: err instanceof Error ? err.message : String(err),
      ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
      ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
      retryable: isSre ? err.retry : false,
    }),
    { format: opts.format, timing: opts.timing },
  );
  process.exitCode = exitCodeForError(err);
}
