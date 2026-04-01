import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { getPreset, getPresetForDetail, getDefaultTokenBudget, getDefaultPresetName } from '../config.js';
import { InvalidRangeError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget, sliceByPage, filterByRole, buildCursorCommands, estimatePageCount } from '../slicer.js';
import { estimateSessionTokens, estimateMessageTokens } from '../tokens.js';
import { getResumeHint } from '../resume.js';
import type { NormalizedMessage, NormalizedSession, SessionSource, ReadOptions, OutputFormat, DetailLevel, SliceMeta, VerbosityPreset, SessionSummary } from '../types.js';

function buildSessionSummary(session: NormalizedSession, tokenBudget: number | undefined): SessionSummary {
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

function computeDetailHint(
  messages: NormalizedMessage[],
  sessionId: string,
  currentPreset: VerbosityPreset,
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

  const upgradeOptions: Array<{ preset: string; estimated_tokens: number; command: string }> = [];
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
      command: `sessionr read ${sessionId} --preset ${name} --tokens ${roundedEst + 2000}`,
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

    // Resolve preset: --detail > --preset > auto (verbose for agents, standard for TTY)
    const detail = opts?.detail as DetailLevel | undefined;
    const presetName = detail
      ? undefined
      : (opts?.preset ?? getDefaultPresetName(isTTY));
    const preset = detail
      ? getPresetForDetail(detail)
      : getPreset(presetName!);

    // Token budget: --tokens flag > SESSIONREADER_MAX_TOKENS env > unlimited
    const tokenBudget = opts?.tokens ?? getDefaultTokenBudget();

    // ── Page-based pagination (--page N) ──────────────────────────────────
    if (opts?.page != null) {
      const budget = tokenBudget ?? 4000;
      const result = sliceByPage(messages, opts.page, budget, session.id, session.source);
      let meta = injectNextAction(result.meta);
      meta.detail_hint = computeDetailHint(result.messages, session.id, preset);

      const outputFormat = opts?.output ?? (opts?.json ? 'json' : (isTTY ? 'text' : 'json'));
      if (outputFormat === 'json' || outputFormat === 'jsonl') {
        const summary = buildSessionSummary(session, budget);
        const envelope = buildJsonEnvelope(session, result.messages, meta, preset, summary);
        console.log(JSON.stringify(envelope, dateReplacer, 2));
      } else {
        console.log(formatter.read(session, result.messages, meta.range.from, meta.range.to, preset, meta));
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

      let meta = injectNextAction(result.meta);
      meta.detail_hint = computeDetailHint(result.messages, session.id, preset);

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
        cursor: { prev: null, next: null, first: null },
      };
      rawMeta.cursor = buildCursorCommands(session.id, rawMeta);

      let meta = injectNextAction(rawMeta);
      meta.detail_hint = computeDetailHint(sliced, session.id, preset);

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

function buildJsonEnvelope(
  session: NormalizedSession,
  messages: NormalizedMessage[],
  meta: SliceMeta,
  _preset: VerbosityPreset,
  summary?: SessionSummary,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = { api_version: 1 };
  if (summary) envelope.session = summary;
  envelope.meta = meta;
  envelope.messages = messages.map((m) => ({
    index: m.index,
    role: m.role,
    timestamp: m.timestamp,
    tokens_estimate: estimateMessageTokens(m),
    content: m.content,
    ...(m.blocks.length > 0 && m.content !== '' &&
        !(m.blocks.length === 1 && m.blocks[0].type === 'text')
      ? { blocks: m.blocks }
      : {}),
  }));

  const sid = meta.session_id;
  const shortSid = sid.length > 8 ? sid.slice(0, 8) : sid;
  envelope.actions = [
    { command: `sessionr stats ${shortSid}`, description: 'Full statistics (tools, tokens, files)' },
    { command: `sessionr context ${shortSid} --tokens 8000`, description: 'Export context for agent handoff' },
    { command: `sessionr diff ${shortSid} <other-id>`, description: 'Compare with another session' },
  ];

  return envelope;
}

function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
