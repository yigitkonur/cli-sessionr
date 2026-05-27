import { cmdPrefix } from '../util/invocation.js';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { exitCodeForError, SessionReaderError } from '../errors.js';
import type { SessionSource, OutputFormat, V2Action } from '../types.js';

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
      const { messages: _messages, ...rest } = session;
      const sessionPayload = serializeDates(rest);
      const prefix = cmdPrefix();
      const actions: V2Action[] = [
        { command: `${prefix} read ${session.id}`, description: 'Read session messages' },
        { command: `${prefix} send ${session.id} -f prompt.md --source ${session.source}`, description: 'Resume session' },
        { command: `${prefix} context ${session.id} --tokens 8000`, description: 'Export context for agent handoff' },
        { command: `${prefix} diff ${session.id} <other-id>`, description: 'Compare with another session' },
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

// Recursively walk an object and convert Date instances to ISO strings so the
// envelope serializer (which uses plain JSON.stringify) produces valid output.
// Phase 0's emit() does not register a Date replacer; commands own date safety.
function serializeDates(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeDates);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeDates(v);
    }
    return out;
  }
  return value;
}
