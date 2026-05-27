import { cmdPrefix } from '../util/invocation.js';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { SessionReaderError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { getDefaultTokenBudget } from '../config.js';
import type { SessionSource, OutputFormat, NormalizedMessage, V2Action } from '../types.js';

export async function contextExportCommand(
  sessionId: string,
  opts: {
    source?: string;
    tokens?: number;
    includeSystemPrompt?: boolean;
    includeToolResults?: boolean;
    format?: 'messages' | 'summary';
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
      const actions: V2Action[] = [
        { command: `${prefix} send --new --source ${session.source} -f prompt.md`, description: 'Start new session with this context' },
        { command: `${prefix} read ${session.id} --tokens 4000`, description: 'Read full session messages' },
      ];
      emit(success(result, { actions }), {
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
