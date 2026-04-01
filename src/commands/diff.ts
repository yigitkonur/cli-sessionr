import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { exitCodeForError } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

export async function diffCommand(
  id1: string,
  id2: string,
  opts: { source?: string; json?: boolean; output?: OutputFormat },
): Promise<void> {
  try {
    const [session1, session2] = await Promise.all([
      loadSession(id1, opts.source as SessionSource | undefined),
      loadSession(id2, opts.source as SessionSource | undefined),
    ]);

    const tools1 = new Set(session1.stats.toolFrequency.map((t) => t.name));
    const tools2 = new Set(session2.stats.toolFrequency.map((t) => t.name));
    const files1 = new Set(session1.stats.filesModified);
    const files2 = new Set(session2.stats.filesModified);

    const diff = {
      api_version: 1,
      sessions: {
        a: {
          id: session1.id,
          source: session1.source,
          message_count: session1.stats.totalMessages,
          model: session1.metadata.model,
          created_at: session1.metadata.createdAt,
        },
        b: {
          id: session2.id,
          source: session2.source,
          message_count: session2.stats.totalMessages,
          model: session2.metadata.model,
          created_at: session2.metadata.createdAt,
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

    console.log(JSON.stringify(diff, dateReplacer, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(
      JSON.stringify({ error: { code: 'DIFF_FAILED', message: error.message } }),
    );
    process.exitCode = exitCodeForError(err);
  }
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
