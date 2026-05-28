import type {
  Formatter,
  NormalizedSession,
  NormalizedMessage,
  VerbosityPreset,
  SessionListEntry,
  SliceMeta,
  ListFooterMeta,
} from '../types.js';
import { SessionReaderError } from '../errors.js';
import { serializeMessage } from './serialize.js';

function line(obj: unknown): string {
  return JSON.stringify(obj, dateReplacer);
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function createJsonlFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      const { messages: _messages, ...rest } = session;
      return line({ type: 'stats', api_version: 1, ...rest });
    },

    read(
      session: NormalizedSession,
      messages: NormalizedMessage[],
      from: number,
      to: number,
      preset: VerbosityPreset,
      meta?: SliceMeta,
    ): string {
      const lines: string[] = [];

      const metaObj = meta ?? {
        session_id: session.id,
        source: session.source,
        total_messages: session.stats.totalMessages,
        range: { from, to },
      };
      lines.push(line({ type: 'meta', ...metaObj }));

      // oc/12: pass the preset through so verbose/full callers get `blocks`
      // and minimal/standard callers get `content` — never both. Without
      // this the JSONL stream paid ~2x bytes for every tool_result message.
      for (const m of messages) {
        lines.push(
          line({
            type: 'message',
            ...serializeMessage(m, { preset: preset.name }),
          }),
        );
      }

      return lines.join('\n');
    },

    list(entries: SessionListEntry[], _meta?: ListFooterMeta): string {
      return entries.map((e) => line({ type: 'session', ...e })).join('\n');
    },

    error(err: Error): string {
      if (err instanceof SessionReaderError) {
        return line({ type: 'error', error: err.toJSON() });
      }
      return line({
        type: 'error',
        error: { code: 'UNKNOWN_ERROR', message: err.message, retry: false },
      });
    },
  };
}
