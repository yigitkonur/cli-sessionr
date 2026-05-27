import type { NormalizedMessage, NormalizedSession } from '../types.js';
import { estimateMessageTokens } from '../tokens.js';

export function serializeMessage(m: NormalizedMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    index: m.index,
    role: m.role,
    timestamp: m.timestamp,
    tokens_estimate: estimateMessageTokens(m),
    content: m.content,
  };

  if (m.blocks.length > 0 && m.content !== '' &&
      !(m.blocks.length === 1 && m.blocks[0].type === 'text')) {
    msg.blocks = m.blocks;
  }

  return msg;
}

// ── External (JSON envelope) field-name conventions ───────────────────────
//
// The v2 envelope contract is snake_case for every field name AND every enum
// value. Internal TypeScript types use camelCase (TS convention). Without an
// explicit rename layer, info/stats/search/list/etc. leak `byRole.toolUse`
// (camelCase) instead of `by_role.tool_use` (snake_case), forcing every
// downstream agent to guess which command honors which convention.
//
// The CAMEL_TO_SNAKE_KEYS map below lists every internal camelCase key that
// must surface as snake_case in JSON envelopes. The keys that need ROLE-VALUE
// remapping too (byRole / byBlockType) get a second pass so their values are
// also snake_case (`tool_use` not `toolUse`).
//
// Maintenance rule: when adding a new camelCase field to any type that ends
// up inside a v2 envelope, add it here OR rename the field at its source.
// Tested by `__tests__/envelope-snake-case.regression.test.ts`.

const CAMEL_TO_SNAKE_KEYS: Record<string, string> = {
  // Top-level field renames on SessionMetadata / SessionStats / etc.
  byRole: 'by_role',
  byBlockType: 'by_block_type',
  tokenUsage: 'token_usage',
  toolFrequency: 'tool_frequency',
  filesModified: 'files_modified',
  durationMs: 'duration_ms',
  gitBranch: 'git_branch',
  gitRepo: 'git_repo',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  fileBytes: 'file_bytes',
  rawLineCount: 'raw_line_count',
  filePath: 'file_path',
  totalMessages: 'total_messages',
  isError: 'is_error',
  toolUseId: 'tool_use_id',
  isEmpty: 'is_empty',
  // Nested enum-style keys that also surface as map keys in byRole /
  // byBlockType / tokenUsage. Because the camelCase form is unambiguous
  // (only ever a contract-leak in our types), we rename them globally
  // wherever they appear — no need for parent-context tracking.
  toolUse: 'tool_use',
  toolResult: 'tool_result',
  cacheRead: 'cache_read',
  cacheCreation: 'cache_creation',
};

/**
 * Walk a value tree converting camelCase keys to snake_case (per the
 * CAMEL_TO_SNAKE_KEYS map) AND converting Date instances to ISO strings.
 * Use this on any object that surfaces in a v2 envelope's `result` —
 * most importantly NormalizedSession / SessionStats / SessionMetadata.
 *
 * Unknown keys are passed through unchanged (so `id`, `source`, `cwd`,
 * `model`, etc. retain their existing snake_case-or-single-word form).
 */
export function toExternal(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toExternal);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const renamed = CAMEL_TO_SNAKE_KEYS[k] ?? k;
      out[renamed] = toExternal(v);
    }
    return out;
  }
  return value;
}

/**
 * Convenience for the common case: serialize a NormalizedSession (minus its
 * raw messages) into the canonical external shape with snake_case keys +
 * ISO dates. Use this from `info`, `stats`, and anywhere else a session
 * descriptor surfaces in a v2 envelope.
 */
export function toExternalSession(session: NormalizedSession): Record<string, unknown> {
  const { messages: _messages, ...rest } = session;
  return toExternal(rest) as Record<string, unknown>;
}
