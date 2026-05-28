import type { NormalizedMessage, NormalizedSession, ContentBlock, PresetName, DetailLevel } from '../types.js';
import { estimateMessageTokens } from '../tokens.js';

/**
 * Options that tell `serializeMessage` how aggressively to dedup the
 * `content` / `blocks` channels and whether to suppress detail for `meta`.
 *
 * Why both? Two different agent contracts collide on the same payload:
 *
 *   - `preset` (minimal/standard/verbose/full) is the user-facing volume
 *     knob. `minimal`/`standard` callers want the cheap flat-text channel
 *     (`content`); `verbose`/`full` callers want the structured `blocks`
 *     channel (with tool args, full results, thinking blobs). Emitting
 *     BOTH everywhere is the oc/12 + oc/13 regression — every tool_result
 *     message paid ~2x the bytes it needed.
 *
 *   - `detail` (full/condensed/skeleton/meta) is the read-command's
 *     orthogonal "how much per-message" knob. `meta` in particular wants
 *     EVERY block stripped — but for tool_use/tool_result messages, the
 *     name + tool_use_id are load-bearing metadata an agent uses to
 *     decide whether to fetch the full message later. We preserve those
 *     two fields (and only those two) in meta mode.
 */
export interface SerializeMessageOpts {
  preset?: PresetName;
  detail?: DetailLevel;
}

/**
 * Serialize a NormalizedMessage for emission inside a v2 envelope.
 *
 * Channel policy (oc/12 + oc/13):
 *
 *   preset \\ messages:    text-only           rich (tool_use/result, thinking, mixed)
 *   ──────────────────────────────────────────────────────────────────────────────────
 *   minimal/standard       content only        content only (blocks stripped)
 *   verbose/full           content only        blocks only  (content stripped)
 *   undefined (default)    content only        blocks only  (no dual-channel waste)
 *
 * The default is "blocks only" for rich messages so callers that don't yet
 * pass an explicit preset (send sync envelope, incidental message snippets
 * from stats/info) still benefit from the dedup. Pre-Phase-3 callers paid
 * 30–60% extra bytes on JSONL streams because every tool_result carried
 * both a truncated flat `content` AND the full structured `blocks` — the
 * default now matches what every modern JSON consumer would want.
 *
 * Detail policy (M3):
 *
 *   detail=meta with role tool_use / tool_result:
 *     - `content` becomes `"Tool: <name>"` so an agent can see what was
 *       invoked without paying for the full payload.
 *     - `tool_use_id` surfaces as a top-level field (joins tool_use ↔
 *       tool_result across the wire).
 *     - `blocks` is dropped entirely.
 */
export function serializeMessage(
  m: NormalizedMessage,
  opts?: SerializeMessageOpts | PresetName,
): Record<string, unknown> {
  // Back-compat: callers that pass a bare preset string get auto-promoted.
  const resolved: SerializeMessageOpts =
    typeof opts === 'string' ? { preset: opts } : (opts ?? {});

  const msg: Record<string, unknown> = {
    index: m.index,
    role: m.role,
    timestamp: m.timestamp,
    tokens_estimate: estimateMessageTokens(m),
    content: m.content,
  };

  // M3 — `--detail meta`: emit a thin per-message stub so agents can
  // enumerate without paying for decoded content. For tool_use /
  // tool_result we PRESERVE two load-bearing fields:
  //
  //   - `content`  → "Tool: <name>"  (lets an agent see which tool ran
  //                                   without re-reading the message)
  //   - `tool_use_id`                 (joins tool_use ↔ tool_result so an
  //                                   agent can fetch the matching pair)
  //
  // For non-tool roles in meta mode, `content` becomes the empty string
  // and `blocks` is dropped entirely. This is the read-command's "give me
  // the table of contents" detail level — the actual content fetch is
  // expected to follow at a higher detail level on demand.
  if (resolved.detail === 'meta') {
    if (m.role === 'tool_use' || m.role === 'tool_result') {
      const ident = extractToolIdentity(m.blocks);
      msg.content = ident.name !== undefined ? `Tool: ${ident.name}` : '';
      if (ident.tool_use_id !== undefined) {
        msg.tool_use_id = ident.tool_use_id;
      }
    } else {
      msg.content = '';
    }
    // `meta` detail mode never carries blocks — the whole point is to
    // give agents an enumerate-without-decoding view.
    return msg;
  }

  // No blocks at all → text-only by definition; flat `content` is enough.
  if (m.blocks.length === 0) {
    return msg;
  }

  // Existing dedup: single-text-block messages where content === text are
  // pure prose; `blocks` would be 100% redundant.
  const isPureTextSingle =
    m.blocks.length === 1 && m.blocks[0].type === 'text';

  if (isPureTextSingle) {
    return msg;
  }

  // Rich content path. Choose one channel based on preset.
  const preset = resolved.preset;
  if (preset === 'minimal' || preset === 'standard') {
    // Low-volume callers: keep the truncated/flat `content`, drop `blocks`.
    return msg;
  }
  if (preset === 'verbose' || preset === 'full') {
    // High-volume callers: drop `content` (already in the blocks) and
    // surface the full structured `blocks` instead.
    delete msg.content;
    msg.blocks = m.blocks.map(externalizeBlock);
    return msg;
  }

  // Default (no preset specified): treat rich messages as if a high-detail
  // preset was implied — surface `blocks` and drop `content` so we never
  // pay the dual-channel cost. This is the safer default for agent
  // consumers and matches what read.ts produces when callers pass
  // `--preset verbose|full`.
  delete msg.content;
  msg.blocks = m.blocks.map(externalizeBlock);
  return msg;
}

/**
 * Convert a single ContentBlock to its snake_case external shape. tool_use
 * and tool_result carry camelCase fields (`toolUseId`, `isError`) that must
 * NOT leak into v2 envelopes — the envelope-snake-case regression suite
 * fails the moment they do.
 *
 * Why a per-block helper instead of routing through `toExternal(blocks)`?
 * Because the generic walker would also rename keys INSIDE tool_use
 * `input` payloads (arbitrary user-tool JSON we must not touch). Per-block
 * walking keeps the contract surgical: only known camelCase block fields
 * get renamed, never a tool's own argument names.
 */
function externalizeBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'tool_use':
      // `input` is opaque tool-specific JSON; pass through unchanged.
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', text: block.text };
  }
}

/**
 * Pull `name` (from a tool_use block) and `toolUseId` (from a tool_result
 * block) out of a message's blocks. Either may be missing; callers should
 * guard on `undefined`. Used by the M3 detail=meta path so agents can join
 * tool_use ↔ tool_result without re-reading.
 */
function extractToolIdentity(blocks: ContentBlock[]): {
  name?: string;
  tool_use_id?: string;
} {
  let name: string | undefined;
  let toolUseId: string | undefined;
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      name ??= b.name;
      toolUseId ??= b.id;
    } else if (b.type === 'tool_result') {
      toolUseId ??= b.toolUseId;
    }
  }
  return { name, tool_use_id: toolUseId };
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
