import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { exitCodeForError, SessionReaderError } from '../errors.js';
import { cmdPrefix } from '../util/invocation.js';
import type { SessionSource, OutputFormat, V2Action } from '../types.js';

export async function diffCommand(
  id1: string,
  id2: string,
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
    const [session1, session2] = await Promise.all([
      loadSession(id1, opts.source as SessionSource | undefined),
      loadSession(id2, opts.source as SessionSource | undefined),
    ]);

    const tools1 = new Set(session1.stats.toolFrequency.map((t) => t.name));
    const tools2 = new Set(session2.stats.toolFrequency.map((t) => t.name));
    const files1 = new Set(session1.stats.filesModified);
    const files2 = new Set(session2.stats.filesModified);

    const largerSession =
      session1.stats.totalMessages >= session2.stats.totalMessages ? session1 : session2;
    const prefix = cmdPrefix();

    const result = {
      sessions: {
        a: {
          id: session1.id,
          source: session1.source,
          message_count: session1.stats.totalMessages,
          model: session1.metadata.model,
          created_at: dateOrNull(session1.metadata.createdAt),
        },
        b: {
          id: session2.id,
          source: session2.source,
          message_count: session2.stats.totalMessages,
          model: session2.metadata.model,
          created_at: dateOrNull(session2.metadata.createdAt),
        },
      },
      tools: {
        only_in_a: [...tools1].filter((t) => !tools2.has(t)),
        only_in_b: [...tools2].filter((t) => !tools1.has(t)),
        in_both: [...tools1].filter((t) => tools2.has(t)),
      },
      files_modified: {
        only_in_a: [...files1].filter((f) => !files2.has(f)),
        only_in_b: [...files2].filter((f) => !files1.has(f)),
        in_both: [...files1].filter((f) => files2.has(f)),
      },
      token_usage: {
        a: session1.stats.tokenUsage ?? null,
        b: session2.stats.tokenUsage ?? null,
      },
    };

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const actions: V2Action[] = [
        { command: `${prefix} read ${largerSession.id}`, description: 'Read the larger session in this comparison' },
        { command: `${prefix} stats ${session1.id}`, description: 'Full stats for session A' },
        { command: `${prefix} stats ${session2.id}`, description: 'Full stats for session B' },
      ];
      emit(success(result, { actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      // text/table fallback: pretty-print the diff result so non-JSON callers
      // still see a deterministic comparison.
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'DIFF_FAILED',
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
