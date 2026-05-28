import { cmdPrefix } from '../util/invocation.js';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { SessionReaderError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { getDefaultTokenBudget } from '../config.js';
import { resolveSource } from '../utils/validate.js';
import type { SessionSource, OutputFormat, NormalizedMessage, V2Action } from '../types.js';

export async function contextExportCommand(
  sessionId: string,
  opts: {
    source?: string;
    tokens?: number;
    includeSystemPrompt?: boolean;
    includeToolResults?: boolean;
    format?: 'messages' | 'summary';
    /** M4: when set, the cross-tool resume hint targets this source instead
     * of the session's original source — so an agent can hand a Claude
     * session off to Codex/Gemini/etc. without rewriting the suggestion. */
    targetSource?: string;
    output?: OutputFormat;
    json?: boolean;
    timing?: boolean;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );

    const tokenBudget = opts.tokens ?? getDefaultTokenBudget() ?? 8000;
    let messages = session.messages;

    // Filter out system messages unless requested
    if (!opts.includeSystemPrompt) {
      messages = messages.filter((m) => m.role !== 'system');
    }

    // Filter out tool results unless requested
    if (!opts.includeToolResults) {
      messages = messages.filter((m) => m.role !== 'tool_result');
    }

    // Slice to fit budget (tail anchor so the handoff captures the latest state)
    const sliceResult = sliceByTokenBudget(
      messages,
      tokenBudget,
      session.id,
      session.source,
      'tail',
    );

    // Extract active files from tool_use blocks
    const activeFiles = new Set<string>();
    for (const msg of session.messages) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_use' && block.input) {
          const filePath =
            (block.input as Record<string, unknown>).file_path ??
            (block.input as Record<string, unknown>).path;
          if (typeof filePath === 'string') activeFiles.add(filePath);
        }
      }
    }

    // Extract last user message as current task
    const lastUserMsg = [...session.messages]
      .reverse()
      .find((m) => m.role === 'user');

    const result = {
      session_id: session.id,
      source: session.source,
      model: session.metadata.model,
      cwd: session.metadata.cwd,
      git_branch: session.metadata.gitBranch,
      messages: opts.format === 'summary'
        ? summarizeMessages(sliceResult.messages)
        : sliceResult.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
      active_files: [...activeFiles].slice(0, 50),
      current_task: lastUserMsg
        ? lastUserMsg.content.slice(0, 500)
        : null,
      token_count_estimate: estimateSessionTokens(sliceResult.messages),
    };

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const prefix = cmdPrefix();
      // M4: cross-tool handoff. If the caller asked for --target-source <X>,
      // suggest spawning the new session on X (validated alias-aware) while
      // keeping the original session's resume path intact. Otherwise default
      // to the original source.
      const targetSource = resolveSource(opts.targetSource) ?? session.source;
      const isCrossTool = targetSource !== session.source;
      const resumeCmd = `${prefix} send --new --source ${targetSource} -f prompt.md`;
      const sameToolResume = `${prefix} send ${session.id} -f prompt.md --source ${session.source}`;
      const actions: V2Action[] = [
        {
          command: resumeCmd,
          description: isCrossTool
            ? `Hand off to ${targetSource} as a new session`
            : 'Start a new session with this context',
        },
        { command: sameToolResume, description: `Resume in original tool (${session.source})` },
        { command: `${prefix} read ${session.id} --tokens 4000`, description: 'Read full session messages' },
      ];

      const nextAction = {
        resume: resumeCmd,
        target_source: targetSource,
        original_source: session.source,
        cross_tool: isCrossTool,
        read: `${prefix} read ${session.id} --tokens 4000`,
        tip: isCrossTool
          ? `Cross-tool handoff: paste current_task + active_files into prompt.md, then run resume to spawn a ${targetSource} session.`
          : 'Write your prompt to prompt.md, then run resume to spawn a new session with this context.',
      };

      emit(success(result, { meta: { next_action: nextAction }, actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      // text/table fallback: pretty-print the result so callers still see it.
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'CONTEXT_EXPORT_FAILED',
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

function summarizeMessages(messages: NormalizedMessage[]): Array<{ role: string; summary: string }> {
  return messages.map((m) => ({
    role: m.role,
    summary: m.content.slice(0, 200) + (m.content.length > 200 ? '...' : ''),
  }));
}
