import { loadSession } from '../discovery.js';
import { SessionReaderError, exitCodeForError } from '../errors.js';
import { sliceByTokenBudget } from '../slicer.js';
import { estimateSessionTokens } from '../tokens.js';
import { getDefaultTokenBudget } from '../config.js';
import type { SessionSource, OutputFormat, NormalizedMessage } from '../types.js';

export async function contextExportCommand(
  sessionId: string,
  opts: {
    source?: string;
    tokens?: number;
    includeSystemPrompt?: boolean;
    includeToolResults?: boolean;
    format?: 'messages' | 'summary';
    output?: OutputFormat;
  },
): Promise<void> {
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

    // Slice to fit budget
    const result = sliceByTokenBudget(
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

    const contextObj: Record<string, unknown> = {
      api_version: 1,
      context: {
        session_id: session.id,
        source: session.source,
        model: session.metadata.model,
        cwd: session.metadata.cwd,
        git_branch: session.metadata.gitBranch,
        messages: opts.format === 'summary'
          ? summarizeMessages(result.messages)
          : result.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
        active_files: [...activeFiles].slice(0, 50),
        current_task: lastUserMsg
          ? lastUserMsg.content.slice(0, 500)
          : null,
        token_count_estimate: estimateSessionTokens(result.messages),
      },
      actions: [
        { command: `sessionr send --new --source ${session.source} -m "based on context from ${session.id}: ..."`, description: 'Start new session with this context' },
        { command: `sessionr read ${session.id} --tokens 4000`, description: 'Read full session messages' },
      ],
    };

    console.log(JSON.stringify(contextObj, null, 2));
  } catch (err) {
    if (err instanceof SessionReaderError) {
      console.error(JSON.stringify({ error: err.toJSON() }, null, 2));
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(JSON.stringify({ error: { code: 'CONTEXT_EXPORT_FAILED', message: error.message, retry: false } }, null, 2));
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
