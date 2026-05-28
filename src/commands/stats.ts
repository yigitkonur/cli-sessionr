import * as path from 'node:path';
import { cmdPrefix } from '../util/invocation.js';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { toExternalSession } from '../output/serialize.js';
import { exitCodeForError, SessionReaderError } from '../errors.js';
import type { SessionSource, OutputFormat, V2Action } from '../types.js';

/**
 * M5: dedupe filesModified by resolving relative paths against the session's
 * cwd and keeping unique absolute paths. Without this, parsers that record
 * the same file under both `src/foo.ts` and `/repo/src/foo.ts` produce
 * double-counted entries in the stats payload.
 */
function dedupFilesModified(files: string[], cwd: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    if (!raw) continue;
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd ?? process.cwd(), raw);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

export async function statsCommand(
  sessionId: string,
  opts: { source?: string; json?: boolean; output?: OutputFormat; timing?: boolean },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      // toExternalSession() drops the raw messages array AND snake-cases every
      // camelCase key (byRole.toolUse → by_role.tool_use, etc.) AND ISO-encodes
      // dates. This is the single canonical projection — info uses toExternal()
      // selectively on subobjects; stats ships the full session payload.
      const sessionPayload = toExternalSession(session) as Record<string, unknown>;

      // M5: rewrite stats.files_modified with dedup'd absolute paths. We mutate
      // a fresh copy of the stats subtree so we don't change the typed object
      // upstream. Files appear ONCE per absolute path regardless of whether
      // the parser recorded them as relative or absolute.
      if (sessionPayload.stats && typeof sessionPayload.stats === 'object') {
        const statsObj = sessionPayload.stats as Record<string, unknown>;
        if (Array.isArray(statsObj.files_modified)) {
          statsObj.files_modified = dedupFilesModified(
            statsObj.files_modified as string[],
            session.metadata.cwd,
          );
        }
      }

      const prefix = cmdPrefix();
      const actions: V2Action[] = [
        { command: `${prefix} read ${session.id} --tokens 8000 --include-summary`, description: 'Read session with summary' },
        { command: `${prefix} send ${session.id} -f prompt.md --source ${session.source}`, description: 'Resume session' },
        { command: `${prefix} context ${session.id} --tokens 8000`, description: 'Export context for agent handoff' },
        { command: `${prefix} diff ${session.id} <other-id>`, description: 'Compare with another session' },
        { command: `${prefix} tag ${session.id} --add important`, description: 'Tag this session' },
        { command: `${prefix} prune --older-than 7d --dry-run`, description: 'Preview cleanup of old sessions' },
      ];
      // it/07: the most useful follow-up for stats is a budgeted read with the
      // summary attached so the agent has narrative + numbers in one fetch.
      const nextAction = {
        read: `${prefix} read ${session.id} --tokens 8000 --include-summary`,
        context: `${prefix} context ${session.id} --tokens 8000`,
        resume: `${prefix} send ${session.id} -f prompt.md --source ${session.source}`,
        tip: 'stats is read-only; combine with read --include-summary to see the messages behind the numbers.',
      };
      emit(success({ session: sessionPayload }, { meta: { next_action: nextAction }, actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(formatter.stats(session) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'STATS_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(formatter.error(error) + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}

