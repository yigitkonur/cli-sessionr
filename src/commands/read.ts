import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { serializeMessage } from '../output/serialize.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { computeETag } from '../etag.js';
import { getPreset, getPresetForDetail, getDefaultTokenBudget, getDefaultPresetName, MAX_CHUNK_BUDGET } from '../config.js';
import { EXIT, InvalidRangeError, SessionReaderError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget, sliceByPage, filterByRole, estimatePageCount } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { getResumeHint } from '../resume.js';
import { cmdPrefix } from '../util/invocation.js';
import type { NormalizedMessage, NormalizedSession, SessionSource, ReadOptions, OutputFormat, DetailLevel, SliceMeta, VerbosityPreset, SessionSummary, DiscoveryWarning, V2Action, V2Meta } from '../types.js';

const VALID_ROLES = ['user', 'assistant', 'system', 'tool_use', 'tool_result'] as const;
const VALID_ANCHORS = ['head', 'tail', 'search'] as const;

function validateRoles(raw: string): string[] {
  const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
  const unknown = roles.filter((r) => !(VALID_ROLES as readonly string[]).includes(r));
  if (unknown.length > 0) {
    throw new SessionReaderError(`Unknown role(s): ${unknown.join(', ')}`, {
      code: 'INVALID_ROLE', exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { provided: roles, unknown, valid: [...VALID_ROLES] },
      suggestion: `${cmdPrefix()} read <id> --role user,assistant`,
    });
  }
  return roles;
}

function validateAnchor(raw: string | undefined): 'head' | 'tail' | 'search' {
  if (!raw) return 'head';
  if (!(VALID_ANCHORS as readonly string[]).includes(raw)) {
    throw new SessionReaderError(`Invalid --anchor "${raw}"`, {
      code: 'INVALID_ANCHOR', exitCode: EXIT.USAGE,
      errorClass: 'validation',
      detail: { provided: raw, valid: [...VALID_ANCHORS] },
      suggestion: `${cmdPrefix()} read <id> --anchor head|tail|search`,
    });
  }
  return raw as 'head' | 'tail' | 'search';
}

function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function buildSessionSummary(session: NormalizedSession, tokenBudget: number | undefined, _preset?: VerbosityPreset): SessionSummary {
  const totalTokens = estimateSessionTokens(session.messages);
  const budget = tokenBudget ?? 4000;
  const pagesEst = estimatePageCount(session.messages, budget);
  const durationMs = session.stats.durationMs;
  let duration: string | undefined;
  if (durationMs != null) {
    const s = Math.floor(durationMs / 1000);
    if (s < 60) duration = `${s}s`;
    else if (s < 3600) duration = `${Math.floor(s / 60)}m ${s % 60}s`;
    else duration = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  return {
    id: session.id,
    source: session.source,
    model: session.metadata.model,
    cwd: session.metadata.cwd,
    git_branch: session.metadata.gitBranch,
    total_messages: session.stats.totalMessages,
    total_tokens_estimate: totalTokens,
    pages_estimate: pagesEst,
    duration,
    by_role: {
      user: session.stats.byRole.user,
      assistant: session.stats.byRole.assistant,
      system: session.stats.byRole.system,
      tool_use: session.stats.byRole.toolUse,
      tool_result: session.stats.byRole.toolResult,
    },
  };
}

function injectNextAction(meta: SliceMeta): SliceMeta {
  const hint = getResumeHint(meta.source, meta.session_id);
  return {
    ...meta,
    next_action: {
      resume: hint.resume,
      resume_async: hint.resume_async,
      direct: hint.direct,
      verified: hint.verified,
      tip: hint.tip,
    },
  };
}

/**
 * it/02 — emit a v2 envelope when --if-changed matches. The result mirrors
 * the canonical success shape so callers can branch on `ok` + a tiny payload
 * (`unchanged: true` and the etag) instead of parsing a separate envelope.
 */
function emitUnchanged(
  session: NormalizedSession,
  etag: string,
  outputFormat: OutputFormat,
  timing: boolean | undefined,
): void {
  const shortSid = session.id.length > 8 ? session.id.slice(0, 8) : session.id;
  const prefix = cmdPrefix();
  emit(
    success(
      {
        unchanged: true,
        etag,
        session_id: session.id,
        source: session.source,
        total_messages: session.stats.totalMessages,
        updated_at: dateToIso(session.metadata.updatedAt),
      },
      {
        meta: { etag },
        actions: [
          { command: `${prefix} read ${shortSid} --if-changed ${etag}`, description: 'Poll again' },
          { command: `${prefix} read ${shortSid}`, description: 'Bypass etag and fetch' },
        ],
      },
    ),
    { format: outputFormat, timing },
  );
  process.exitCode = EXIT.NO_CHANGES;
}

function computeDetailHint(
  messages: NormalizedMessage[],
  sessionId: string,
  currentPreset: VerbosityPreset,
  currentBudget: number,
  currentReturnedTokens: number,
): SliceMeta['detail_hint'] {
  if (currentPreset.name === 'full') return undefined;

  let hiddenToolCalls = 0;
  let truncatedResults = 0;
  let thinkingHidden = false;

  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && !currentPreset.showToolArgs) {
        hiddenToolCalls++;
      }
      if (block.type === 'tool_result' && !currentPreset.showToolResults) {
        truncatedResults++;
      } else if (block.type === 'tool_result' && currentPreset.maxToolResultChars < Infinity) {
        if (block.content.length > currentPreset.maxToolResultChars) truncatedResults++;
      }
      if (block.type === 'thinking' && !currentPreset.showThinking) {
        thinkingHidden = true;
      }
    }
  }

  if (hiddenToolCalls === 0 && truncatedResults === 0 && !thinkingHidden) return undefined;

  const prefix = cmdPrefix();
  const upgradeOptions: Array<{
    preset: string;
    estimated_tokens: number;
    will_fit_in_current_budget: boolean;
    delta_vs_current_tokens: number;
    command: string;
  }> = [];
  const presetNames = ['verbose', 'full'] as const;
  for (const name of presetNames) {
    if (name === currentPreset.name) continue;
    const p = getPreset(name);
    let est = 0;
    for (const msg of messages) {
      est += 4; // role overhead
      for (const block of msg.blocks) {
        switch (block.type) {
          case 'text': {
            const len = p.maxContentChars === Infinity ? block.text.length : Math.min(block.text.length, p.maxContentChars);
            est += Math.ceil(len / 4);
            break;
          }
          case 'thinking': {
            if (p.showThinking) {
              const len = p.maxThinkingChars === Infinity ? block.text.length : Math.min(block.text.length, p.maxThinkingChars);
              est += Math.ceil(len / 4);
            }
            break;
          }
          case 'tool_use': {
            est += Math.ceil(block.name.length / 4);
            if (p.showToolArgs) {
              const raw = JSON.stringify(block.input);
              const len = p.maxToolInputChars === Infinity ? raw.length : Math.min(raw.length, p.maxToolInputChars);
              est += Math.ceil(len / 4);
            }
            break;
          }
          case 'tool_result': {
            if (p.showToolResults) {
              const len = p.maxToolResultChars === Infinity ? block.content.length : Math.min(block.content.length, p.maxToolResultChars);
              est += Math.ceil(len / 4);
            }
            break;
          }
        }
      }
    }
    const roundedEst = Math.round(est / 100) * 100 || 100;
    upgradeOptions.push({
      preset: name,
      estimated_tokens: roundedEst,
      will_fit_in_current_budget: roundedEst <= currentBudget,
      delta_vs_current_tokens: roundedEst - currentReturnedTokens,
      command: `${prefix} read ${sessionId} --preset ${name} --tokens ${Math.max(roundedEst + 2000, currentBudget)}`,
    });
  }

  return {
    current_preset: currentPreset.name,
    hidden_tool_calls: hiddenToolCalls,
    truncated_results: truncatedResults,
    thinking_hidden: thinkingHidden,
    upgrade_options: upgradeOptions,
  };
}

export async function readCommand(
  sessionId: string,
  fromStr?: string,
  toStr?: string,
  opts?: ReadOptions,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat =
    (opts?.output as OutputFormat | undefined) ??
    (opts?.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts?.output as OutputFormat | undefined,
    json: opts?.json,
    isTTY,
  });

  try {
    if (opts?.batch) {
      await readBatchCommand(opts, isTTY);
      return;
    }

    const warnings: DiscoveryWarning[] = [];
    const session = await loadSession(
      sessionId,
      opts?.source as SessionSource | undefined,
      (warning: DiscoveryWarning) => warnings.push(warning),
    );

    let messages = session.messages;
    const totalMessages = session.stats.totalMessages;

    // Role filtering (applied before slicing)
    if (opts?.role) {
      const roles = validateRoles(opts.role);
      messages = filterByRole(messages, roles);
    }

    const requestedAnchor = validateAnchor(opts?.anchor);
    if (requestedAnchor === 'search' && !opts?.search) {
      throw new SessionReaderError('--anchor search requires --search <query>', {
        code: 'INVALID_ANCHOR_USAGE',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        suggestion: `${cmdPrefix()} read <id> --anchor search --search "<term>"`,
      });
    }

    // Resolve preset: --detail > --preset > auto (verbose for agents, standard for TTY)
    const detail = opts?.detail as DetailLevel | undefined;
    const presetName = detail
      ? undefined
      : (opts?.preset ?? getDefaultPresetName(isTTY));
    const preset = detail
      ? getPresetForDetail(detail)
      : getPreset(presetName!);

    // Token budget: --tokens flag > SESSIONREADER_MAX_TOKENS env > default 8K, always capped
    if (opts?.tokens != null && (!Number.isFinite(opts.tokens) || opts.tokens <= 0)) {
      throw new SessionReaderError('--tokens must be > 0', {
        code: 'INVALID_TOKEN_BUDGET',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        detail: { provided: opts.tokens },
        suggestion: `${cmdPrefix()} read <id> --tokens 4000`,
      });
    }
    const rawBudget = opts?.tokens ?? getDefaultTokenBudget();
    const tokenBudget = Math.min(rawBudget, MAX_CHUNK_BUDGET);

    const summary = buildSessionSummary(session, tokenBudget, preset);

    // Empty session — emit a clean envelope instead of throwing InvalidRangeError.
    // Sessions can be opened without any user/assistant exchange (Factory "New Session",
    // Claude blank sessions, etc.); list filters them out, but a direct ID paste can
    // still land here.
    if (totalMessages === 0) {
      const emptyMeta: SliceMeta = {
        session_id: session.id,
        source: session.source,
        total_messages: 0,
        total_tokens_estimate: 0,
        returned_tokens_estimate: 0,
        token_budget: tokenBudget,
        anchor: 'head',
        range: { from: 0, to: 0 },
        has_more_before: false,
        has_more_after: false,
        cursor_before: null,
        cursor_after: null,
        cursor: { next: null, prev: null, first: null },
      };
      const meta = injectNextAction(emptyMeta);

      if (outputFormat === 'json' || outputFormat === 'jsonl') {
        emitReadEnvelope({
          session,
          messages: [],
          meta,
          summary,
          includeSummary: shouldIncludeSummary(opts),
          outputFormat,
          timing: opts?.timing,
          notice: 'session is empty (no user/assistant messages)',
        });
      } else {
        process.stdout.write(`Session ${session.id} (${session.source}) is empty — no messages.\n`);
      }
      return;
    }

    // ── Page-based pagination (--page N) ──────────────────────────────────
    if (opts?.page != null) {
      const result = sliceByPage(messages, opts.page, tokenBudget, session.id, session.source, preset);
      let meta = injectNextAction(result.meta);
      meta = annotateMeta(meta, tokenBudget, preset);
      meta = attachETag(meta, session, {
        preset,
        tokenBudget,
        anchor: undefined,
        search: opts?.search,
        page: opts.page,
        format: outputFormat,
      });
      meta.detail_hint = computeDetailHint(result.messages, session.id, preset, tokenBudget, meta.returned_tokens_estimate);

      // it/01+02: short-circuit when caller's --if-changed etag matches.
      if (opts?.ifChanged && meta.etag === opts.ifChanged) {
        emitUnchanged(session, meta.etag, outputFormat, opts?.timing);
        return;
      }

      if (outputFormat === 'json' || outputFormat === 'jsonl') {
        emitReadEnvelope({
          session,
          messages: result.messages,
          meta,
          summary,
          includeSummary: shouldIncludeSummary(opts),
          outputFormat,
          timing: opts?.timing,
        });
      } else {
        process.stdout.write(
          formatter.read(session, result.messages, meta.range.from, meta.range.to, preset, meta) + '\n',
        );
      }
      return;
    }

    // Cursor-based pagination: --before / --after override positional from/to
    let from: number;
    let to: number;

    if (opts?.before != null) {
      to = opts.before;
      from = 1;
    } else if (opts?.after != null) {
      from = opts.after;
      to = messages.length;
    } else {
      from = fromStr ? parseInt(fromStr, 10) : 1;
      to = toStr ? parseInt(toStr, 10) : messages.length;
    }

    if (from < 1 || to > totalMessages || from > to) {
      throw new InvalidRangeError(from, to, totalMessages);
    }

    // Apply range first (positional/cursor)
    let sliced = messages.slice(from - 1, to);

    // Always apply token budget (8K max enforced)
    const anchor = opts?.search
      ? 'search' as const
      : (requestedAnchor ?? 'head');

    const sliceResult = sliceByTokenBudget(
      sliced,
      tokenBudget,
      session.id,
      session.source,
      anchor,
      opts?.search,
      preset,
    );

    let meta = injectNextAction(sliceResult.meta);
    meta = annotateMeta(meta, tokenBudget, preset);
    meta = attachETag(meta, session, {
      preset,
      tokenBudget,
      anchor,
      search: opts?.search,
      page: undefined,
      format: outputFormat,
    });
    meta.detail_hint = computeDetailHint(sliceResult.messages, session.id, preset, tokenBudget, meta.returned_tokens_estimate);

    // it/01+02: short-circuit when caller's --if-changed etag matches.
    if (opts?.ifChanged && meta.etag === opts.ifChanged) {
      emitUnchanged(session, meta.etag, outputFormat, opts?.timing);
      return;
    }

    let outputMessages = sliceResult.messages;
    if (detail === 'meta') {
      outputMessages = outputMessages.map((m) => ({
        ...m,
        content: '',
        blocks: [],
      }));
    } else if (detail === 'skeleton') {
      outputMessages = outputMessages.map((m) => ({
        ...m,
        content: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : ''),
        blocks: [{ type: 'text' as const, text: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : '') }],
      }));
    }

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      emitReadEnvelope({
        session,
        messages: outputMessages,
        meta,
        summary,
        includeSummary: shouldIncludeSummary(opts),
        outputFormat,
        timing: opts?.timing,
      });
    } else {
      process.stdout.write(
        formatter.read(session, outputMessages, meta.range.from, meta.range.to, preset, meta) + '\n',
      );
    }

    // Signal partial reads (truncated by token budget) via PARTIAL exit code
    if (meta.partial) {
      process.exitCode = EXIT.PARTIAL;
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'READ_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts?.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(formatter.error(error) + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}

async function readBatchCommand(opts: ReadOptions, isTTY: boolean): Promise<void> {
  // --batch streams one v2 envelope per session as JSONL. Each line is a
  // complete envelope (ok + schema_version + result containing the session
  // payload) so consumers can pipe through `jq -c '.result'` uniformly.
  const rawIds = await readFile(opts.batch!, 'utf-8');
  const ids = rawIds.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
  const detail = opts.detail as DetailLevel | undefined;
  const presetName = detail
    ? undefined
    : (opts.preset ?? getDefaultPresetName(isTTY));
  const preset = detail
    ? getPresetForDetail(detail)
    : getPreset(presetName!);
  const rawBudget = opts.tokens ?? getDefaultTokenBudget();
  const tokenBudget = Math.min(rawBudget, MAX_CHUNK_BUDGET);

  // Emit a batch header as the first JSONL envelope so consumers can sanity-
  // check the run before unrolling individual session envelopes.
  emit(
    success({ batch_header: true, count: ids.length, budget: tokenBudget, preset: preset.name }),
    { format: 'jsonl' },
  );

  for (const id of ids) {
    const session = await loadSession(id, opts.source as SessionSource | undefined);
    let messages = session.messages;
    if (opts.role) {
      const roles = opts.role.split(',').map((r) => r.trim());
      messages = filterByRole(messages, roles);
    }

    const result = sliceByTokenBudget(
      messages,
      tokenBudget,
      session.id,
      session.source,
      (opts.search ? 'search' : (opts.anchor ?? 'head')) as 'head' | 'tail' | 'search',
      opts.search,
      preset,
    );
    let meta = injectNextAction(result.meta);
    meta = annotateMeta(meta, tokenBudget, preset);
    meta.detail_hint = computeDetailHint(result.messages, session.id, preset, tokenBudget, meta.returned_tokens_estimate);

    emitReadEnvelope({
      session,
      messages: result.messages,
      meta,
      summary: buildSessionSummary(session, tokenBudget, preset),
      includeSummary: true,
      outputFormat: 'jsonl',
      timing: opts.timing,
    });
  }
}

function annotateMeta(meta: SliceMeta, tokenBudget: number, preset: VerbosityPreset): SliceMeta {
  return {
    ...meta,
    budget: tokenBudget,
    preset: preset.name,
  };
}

/**
 * Compute the response ETag and inject it into SliceMeta. it/01 + it/03:
 * the etag must encode every view-affecting parameter (preset, budget,
 * range, anchor, search, page, format) so two different views of the same
 * session produce different etags and --if-changed polling stays correct.
 */
function attachETag(
  meta: SliceMeta,
  session: NormalizedSession,
  args: {
    preset: VerbosityPreset;
    tokenBudget: number;
    anchor?: string;
    search?: string;
    page?: number;
    format: string;
  },
): SliceMeta {
  const etag = computeETag(session, {
    preset: args.preset.name,
    tokenBudget: args.tokenBudget,
    from: meta.range.from,
    to: meta.range.to,
    anchor: args.anchor,
    search: args.search,
    page: args.page,
    format: args.format,
  });
  return { ...meta, etag };
}

function shouldIncludeSummary(opts?: ReadOptions): boolean {
  return opts?.includeSummary === true || opts?.page == null || opts.page === 1;
}

interface EmitReadArgs {
  session: NormalizedSession;
  messages: NormalizedMessage[];
  meta: SliceMeta;
  summary?: SessionSummary;
  includeSummary: boolean;
  outputFormat: OutputFormat;
  timing?: boolean;
  notice?: string;
}

/**
 * Build a v2 envelope for read responses. `result` contains the session
 * summary + serialized messages; `meta` carries the SliceMeta (pagination,
 * etag, partial flag, etc.). `actions` are deterministic per-session
 * recommendations agents can run next.
 */
function emitReadEnvelope(args: EmitReadArgs): void {
  const serializedMessages = args.messages.map((m) => serializeForJson(serializeMessage(m)));
  const result: Record<string, unknown> = {
    messages: serializedMessages,
  };
  if (args.summary && args.includeSummary) result.session = args.summary;
  if (args.notice) result.notice = args.notice;

  const meta: V2Meta = { ...args.meta } as unknown as V2Meta;
  meta.session_id = args.meta.session_id;
  meta.source = args.meta.source;
  // Note: SliceMeta already lives flat under meta — V2Meta extends Record
  // so all its keys (range, anchor, cursor, partial, etag, next_action,
  // detail_hint, etc.) survive intact.

  const actions = buildActions(args.meta);

  emit(success(serializeForJson(result), { meta: serializeForJson(meta) as V2Meta, actions }), {
    format: args.outputFormat,
    timing: args.timing,
  });
}

function buildActions(meta: SliceMeta): V2Action[] {
  const sid = meta.session_id;
  const shortSid = sid.length > 8 ? sid.slice(0, 8) : sid;
  const prefix = cmdPrefix();
  return [
    { command: `${prefix} stats ${shortSid}`, description: 'Full statistics (tools, tokens, files)' },
    { command: `${prefix} context ${shortSid} --tokens 8000`, description: 'Export context for agent handoff' },
    { command: `${prefix} diff ${shortSid} <other-id>`, description: 'Compare with another session' },
  ];
}

function dateToIso(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  return d instanceof Date ? d.toISOString() : d;
}

// Recursive walk: convert Date instances to ISO strings so plain JSON.stringify
// in emit() produces valid output. Phase 0's emit() does not register a Date
// replacer; commands own date safety.
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
