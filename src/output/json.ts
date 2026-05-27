// JSON formatter (legacy Formatter interface implementation).
//
// As of Phase 2 every command emits its v2 envelope directly through
// `emit(success|failure)`, so this formatter is rarely on the hot path —
// it sticks around to keep the `Formatter` interface (tty / plain / json /
// jsonl) symmetrical and to give any out-of-tree caller that imports
// `createJsonFormatter()` a v2-shaped result instead of a v1-shaped one.
//
// Routing rule: every method returns the JSON.stringify of a v2 envelope
// (`{ ok, schema_version, result|error }`). Date instances are walked and
// converted to ISO strings so callers don't have to register their own
// JSON.stringify replacer.

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
import { success, failure } from './envelope.js';

export function createJsonFormatter(): Formatter {
  return {
    stats(session: NormalizedSession): string {
      const { messages: _messages, ...rest } = session;
      return JSON.stringify(success({ session: serializeForJson(rest) }));
    },

    read(
      session: NormalizedSession,
      messages: NormalizedMessage[],
      from: number,
      to: number,
      _preset: VerbosityPreset,
      meta?: SliceMeta,
    ): string {
      const result: Record<string, unknown> = {
        messages: messages.map((m) => serializeForJson(serializeMessage(m))),
      };
      const effectiveMeta = meta
        ? serializeForJson(meta)
        : {
            session_id: session.id,
            source: session.source,
            total_messages: session.stats.totalMessages,
            range: { from, to },
            token_budget: null,
            anchor: null,
          };
      return JSON.stringify(
        success(result, { meta: effectiveMeta as Record<string, unknown> }),
      );
    },

    list(entries: SessionListEntry[], _meta?: ListFooterMeta): string {
      return JSON.stringify(
        success({ sessions: entries.map((e) => serializeForJson(e)) }),
      );
    },

    error(err: Error): string {
      if (err instanceof SessionReaderError) {
        return JSON.stringify(
          failure({
            class: err.class,
            code: err.code,
            message: err.message,
            ...(Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
            ...(err.suggestion ? { suggestion: err.suggestion } : {}),
            retryable: err.retry,
          }),
        );
      }
      return JSON.stringify(
        failure({
          class: 'internal',
          code: 'UNKNOWN_ERROR',
          message: err.message,
          retryable: false,
        }),
      );
    },
  };
}

function serializeForJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeForJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeForJson(v);
    }
    return out;
  }
  return value;
}
