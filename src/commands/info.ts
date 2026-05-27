import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { toExternal } from '../output/serialize.js';
import { exitCodeForError, SessionReaderError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, V2Action } from '../types.js';

export async function infoCommand(
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
      const prefix = cmdPrefix();
      // toExternal() snake-cases nested keys (byRole.toolUse → by_role.tool_use,
      // tokenUsage.cacheRead → token_usage.cache_read, etc.) and converts Dates
      // to ISO strings. info ships the lightweight projection: identity +
      // metadata + headline stats. Full session details live in `stats`.
      const sessionPayload = {
        id: session.id,
        source: session.source,
        cwd: session.metadata.cwd,
        model: session.metadata.model,
        git_branch: session.metadata.gitBranch,
        created_at: dateOrNull(session.metadata.createdAt),
        updated_at: dateOrNull(session.metadata.updatedAt),
        total_messages: session.stats.totalMessages,
        by_role: toExternal(session.stats.byRole),
        token_usage: toExternal(session.stats.tokenUsage),
        duration_ms: session.stats.durationMs,
      };
      const actions: V2Action[] = [
        { command: `${prefix} read ${session.id}`, description: 'Read session messages' },
        { command: `${prefix} stats ${session.id}`, description: 'Full statistics (tools, tokens, files)' },
        { command: `${prefix} send ${session.id} -f prompt.md --source ${session.source}`, description: 'Resume session' },
        { command: `${prefix} context ${session.id} --tokens 8000`, description: 'Export context for agent handoff' },
        { command: `${prefix} tag ${session.id} --add important`, description: 'Tag this session' },
        { command: `${prefix} prune --older-than 7d --dry-run`, description: 'Preview cleanup of old sessions' },
      ];
      emit(success({ session: sessionPayload }, { actions }), {
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
          code: isSre ? err.code : 'INFO_FAILED',
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

function dateOrNull(d: Date | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}
