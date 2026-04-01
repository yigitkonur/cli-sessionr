import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { getPreset, getPresetForDetail, getDefaultTokenBudget } from '../config.js';
import { InvalidRangeError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget, filterByRole } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { getResumeHint } from '../resume.js';
import type { SessionSource, ReadOptions, OutputFormat, DetailLevel, SliceMeta } from '../types.js';

function injectNextAction(meta: SliceMeta): SliceMeta {
  const hint = getResumeHint(meta.source, meta.session_id);
  return {
    ...meta,
    next_action: {
      description: hint.description,
      interactive: hint.interactive,
      non_interactive: hint.nonInteractive,
      verified: hint.verified,
    },
  };
}

export async function readCommand(
  sessionId: string,
  fromStr?: string,
  toStr?: string,
  opts?: ReadOptions,
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const formatter = createFormatter({
    output: opts?.output as OutputFormat | undefined,
    json: opts?.json,
    isTTY,
  });

  try {
    const session = await loadSession(
      sessionId,
      opts?.source as SessionSource | undefined,
    );

    let messages = session.messages;
    const totalMessages = session.stats.totalMessages;

    // Role filtering (applied before slicing)
    if (opts?.role) {
      const roles = opts.role.split(',').map((r) => r.trim());
      messages = filterByRole(messages, roles);
    }

    // Resolve preset from --detail or --preset
    const detail = opts?.detail as DetailLevel | undefined;
    const preset = detail
      ? getPresetForDetail(detail)
      : getPreset(opts?.preset ?? 'standard');

    // Token budget: --tokens flag > SESSIONREADER_MAX_TOKENS env > unlimited
    const tokenBudget = opts?.tokens ?? getDefaultTokenBudget();

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

    // Token-aware slicing
    if (tokenBudget) {
      const anchor = opts?.search
        ? 'search' as const
        : (opts?.anchor ?? 'tail') as 'head' | 'tail' | 'search';

      const result = sliceByTokenBudget(
        sliced,
        tokenBudget,
        session.id,
        session.source,
        anchor,
        opts?.search,
      );

      const meta = injectNextAction(result.meta);

      if (detail === 'meta') {
        const metaMessages = result.messages.map((m) => ({
          ...m,
          content: '',
          blocks: [],
        }));
        console.log(
          formatter.read(session, metaMessages, meta.range.from, meta.range.to, preset, meta),
        );
      } else if (detail === 'skeleton') {
        const skelMessages = result.messages.map((m) => ({
          ...m,
          content: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : ''),
          blocks: [{ type: 'text' as const, text: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : '') }],
        }));
        console.log(
          formatter.read(session, skelMessages, meta.range.from, meta.range.to, preset, meta),
        );
      } else {
        console.log(
          formatter.read(session, result.messages, meta.range.from, meta.range.to, preset, meta),
        );
      }
    } else {
      // No token budget — use plain range
      const totalTokensEst = estimateSessionTokens(sliced);
      const rawMeta: SliceMeta = {
        session_id: session.id,
        source: session.source,
        total_messages: totalMessages,
        total_tokens_estimate: estimateSessionTokens(session.messages),
        returned_tokens_estimate: totalTokensEst,
        token_budget: null,
        anchor: null,
        range: { from, to },
        has_more_before: from > 1,
        has_more_after: to < totalMessages,
        cursor_before: from > 1 ? from - 1 : null,
        cursor_after: to < totalMessages ? to + 1 : null,
      };

      const meta = injectNextAction(rawMeta);

      if (detail === 'meta') {
        sliced = sliced.map((m) => ({ ...m, content: '', blocks: [] }));
      } else if (detail === 'skeleton') {
        sliced = sliced.map((m) => ({
          ...m,
          content: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : ''),
          blocks: [{ type: 'text' as const, text: m.content.slice(0, 60) + (m.content.length > 60 ? '...' : '') }],
        }));
      }

      console.log(formatter.read(session, sliced, from, to, preset, meta));
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(formatter.error(error));
    process.exitCode = exitCodeForError(err);
  }
}
