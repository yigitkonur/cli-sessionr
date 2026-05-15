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

export function createJsonFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      const { messages: _messages, ...rest } = session;
      return JSON.stringify(
        { api_version: 1, ...rest },
        dateReplacer,
        2,
      );
    },

    read(
      session: NormalizedSession,
      messages: NormalizedMessage[],
      from: number,
      to: number,
      _preset: VerbosityPreset,
      meta?: SliceMeta,
    ): string {
      const envelope: Record<string, unknown> = {
        api_version: 1,
      };

      if (meta) {
        envelope.meta = meta;
      } else {
        envelope.meta = {
          session_id: session.id,
          source: session.source,
          total_messages: session.stats.totalMessages,
          range: { from, to },
          token_budget: null,
          anchor: null,
        };
      }

      envelope.messages = messages.map(serializeMessage);

      return JSON.stringify(envelope, dateReplacer, 2);
    },

    list(entries: SessionListEntry[], _meta?: ListFooterMeta): string {
      return JSON.stringify(
        { api_version: 1, sessions: entries },
        dateReplacer,
        2,
      );
    },

    error(err: Error): string {
      if (err instanceof SessionReaderError) {
        return JSON.stringify({ error: err.toJSON() }, null, 2);
      }
      return JSON.stringify(
        { error: { code: 'UNKNOWN_ERROR', message: err.message, retry: false } },
        null,
        2,
      );
    },
  };
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
