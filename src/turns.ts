import type {
  NormalizedMessage,
  NormalizedSession,
  SessionMetadata,
  Turn,
  TurnPrompt,
  TurnFilesChanged,
  TurnCommand,
  TurnExecutionFacts,
  PendingToolCall,
  TurnUsage,
  CodexRateLimits,
  TurnEndEvent,
} from './types.js';
import { SessionReaderError, EXIT } from './errors.js';
import { computePendingToolCalls } from './slicer.js';

/**
 * Model context window sizes in tokens.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-haiku': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-2': 100_000,

  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-5.4': 128_000,
  'gpt-5': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'gpt-4-32k': 32_768,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,

  // Google Gemini
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.0-pro': 2_000_000,
  'gemini-3.8-flash': 1_000_000,
  'gemini-3.8': 1_000_000,

  // Open Source & Frontier
  'deepseek-v3': 64_000,
  'deepseek-r1': 64_000,
  'llama-3.3': 128_000,
  'llama-3.1': 128_000,
  'qwen-2.5': 128_000,
};

/**
 * Derive model context window size based on model name or session metadata.
 */
export function deriveContextWindow(
  model?: string,
  metadata?: SessionMetadata,
): number | undefined {
  if (metadata?.contextWindow && typeof metadata.contextWindow === 'number') {
    return metadata.contextWindow;
  }
  if (!model) return undefined;
  const normalized = model.toLowerCase().trim();

  for (const [prefix, windowSize] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized === prefix || normalized.startsWith(prefix) || normalized.includes(prefix)) {
      return windowSize;
    }
  }

  const kMatch = normalized.match(/(\d+)k\b/);
  if (kMatch && kMatch[1]) {
    return parseInt(kMatch[1], 10) * 1024;
  }
  const mMatch = normalized.match(/(\d+)m\b/);
  if (mMatch && mMatch[1]) {
    return parseInt(mMatch[1], 10) * 1_000_000;
  }

  return 128_000;
}

/**
 * Determines whether a message represents a genuine user prompt initiating a turn.
 */
export function isGenuinePrompt(msg: NormalizedMessage): boolean {
  if (msg.role !== 'user') return false;

  // If source classification is present (e.g. from Claude adapter)
  if (msg.source) {
    if (msg.source === 'prompt' || (msg.source as string) === 'typed') return true;
    if (['local_command', 'interrupt', 'task_notification', 'system', 'queued', 'injected'].includes(msg.source)) {
      return false;
    }
  }

  if (!msg.content || !msg.content.trim()) return false;
  const trimmed = msg.content.trim();

  if (trimmed === '[empty]' || trimmed === '[error]') return false;

  // Exclude system injected prompts
  if (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<permissions') ||
    trimmed.startsWith('<context_window') ||
    trimmed.startsWith('<user_instructions>') ||
    trimmed.startsWith('# AGENTS.md') ||
    trimmed.startsWith('<ADDITIONAL_METADATA>') ||
    trimmed.startsWith('<USER_SETTINGS_CHANGE>') ||
    trimmed.startsWith('<system>')
  ) {
    return false;
  }

  // Exclude interrupts
  if (
    trimmed.startsWith('[Request interrupted') ||
    trimmed.startsWith('User interrupted execution')
  ) {
    return false;
  }

  // Exclude local slash commands
  if (/^\/(compact|clear|model|effort|config|copy|export|doctor|cost)(\s|$|<)/.test(trimmed)) {
    return false;
  }

  // Exclude task notifications
  if (trimmed.startsWith('<task-notification') || trimmed.startsWith('<task-id>')) {
    return false;
  }

  return true;
}

/**
 * Command inputs may be argv arrays (Codex shell/exec_command). Join those with spaces instead of letting
 * String() produce "ls,-la"; otherwise take the first non-empty value, as before.
 */
function joinCommand(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (Array.isArray(value)) {
      if (value.length > 0) return value.map(String).join(' ');
    } else if (value) {
      return String(value);
    }
  }
  return '';
}

function safeIsoString(d: Date | unknown): string {
  if (d instanceof Date && !isNaN(d.getTime())) {
    return d.toISOString();
  }
  return '';
}

/**
 * Identify pending tool calls within given messages. Delegates to the slicer's tracker so a turn reports
 * the same shape (id, messageIndex, superseded) as session.pending_tool_calls.
 */
export function findTurnPendingToolCalls(messages: NormalizedMessage[]): PendingToolCall[] {
  return computePendingToolCalls(messages);
}

/**
 * Clean and unquote file paths safely.
 */
function sanitizeFilePath(raw: string): string {
  let s = raw.trim();
  while (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Extract files changed within a slice of messages.
 */
export function extractTurnFilesChanged(messages: NormalizedMessage[]): TurnFilesChanged {
  const results = new Map(messages.flatMap(m => m.blocks.filter(b => b.type === 'tool_result').map(b => [b.toolUseId, b] as const)));
  const created = new Set<string>();
  const edited = new Set<string>();
  const deleted = new Set<string>();

  const PATCH_ADD = /\*{3}\s+Add File:?\s*([^\r\n]+)/gi;
  const PATCH_UPDATE = /\*{3}\s+Update File:?\s*([^\r\n]+)/gi;
  const PATCH_DELETE = /\*{3}\s+Delete File:?\s*([^\r\n]+)/gi;

  for (const msg of messages) {
    if (msg.role === 'tool_use') {
      for (const b of msg.blocks) {
        if (b.type === 'tool_use') {
          const result = results.get(b.id);
          if (!result || result.isError) continue;
          const name = b.name.toLowerCase();
          const inp = b.input || {};

          // Check patch strings in apply_patch / applyPatch / exec unrolled
          const patchStr = typeof inp.patch === 'string' ? inp.patch : typeof inp.input === 'string' ? inp.input : '';
          if (patchStr) {
            let m: RegExpExecArray | null;
            while ((m = PATCH_ADD.exec(patchStr)) !== null) created.add(sanitizeFilePath(m[1]));
            while ((m = PATCH_UPDATE.exec(patchStr)) !== null) edited.add(sanitizeFilePath(m[1]));
            while ((m = PATCH_DELETE.exec(patchStr)) !== null) deleted.add(sanitizeFilePath(m[1]));

            // Classify each unified diff section independently.
            for (const section of patchStr.split(/(?=^diff --git )/m)) {
              const headers = section.match(/^--- (.+)\r?\n\+\+\+ (.+)$/m);
              if (!headers) continue;
              const oldPath = headers[1].trim();
              const newPath = headers[2].trim();
              if (oldPath === '/dev/null') created.add(sanitizeFilePath(newPath.replace(/^b\//, '')));
              else if (newPath === '/dev/null') deleted.add(sanitizeFilePath(oldPath.replace(/^a\//, '')));
              else edited.add(sanitizeFilePath(newPath.replace(/^b\//, '')));
            }
          }

          const fileTarget =
            inp.TargetFile ||
            inp.target_file ||
            inp.file_path ||
            inp.notebook_path ||
            inp.filePath ||
            inp.path ||
            inp.file ||
            inp.filename ||
            inp.dest_file;

          if (typeof fileTarget === 'string' && fileTarget.trim()) {
            const cleanPath = sanitizeFilePath(fileTarget);
            if (['write', 'write_to_file', 'create_file', 'createfile', 'create', 'write_file', 'writefile', 'new_empty_file'].includes(name)) {
              created.add(cleanPath);
            } else if (['edit', 'multiedit', 'notebookedit', 'replace_file_content', 'replacefilecontent', 'str_replace_editor', 'str_replace_placeholder', 'edit_file', 'editfile', 'editfiles', 'modify_file'].includes(name)) {
              edited.add(cleanPath);
            } else if (['delete_file', 'deletefile', 'remove_file', 'removefile', 'delete', 'rm_file'].includes(name)) {
              deleted.add(cleanPath);
            }
          }

          // Only infer literal, standalone touch/rm operands. A shell script or quoted
          // command embedded in echo/ssh/heredoc text is not proof of a local edit.
          if (['bash', 'exec_command', 'run_command', 'execute_command', 'terminal'].includes(name)) {
            const cmd = joinCommand(inp.command, inp.CommandLine, inp.cmd);
            const simple = cmd.match(/^\s*(?:git\s+)?(touch|rm)\s+(.+?)\s*$/);
            if (simple && !/[\r\n;|&`$<>]/.test(cmd)) {
              const operands = simple[2].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
              let flags = true;
              const paths: string[] = [];
              let supported = true;
              for (const operand of operands) {
                if (flags && operand === '--') { flags = false; continue; }
                if (flags && operand.startsWith('-')) {
                  if (simple[1] !== 'rm' || !/^-[rfiv]+$/.test(operand)) supported = false;
                  continue;
                }
                paths.push(sanitizeFilePath(operand));
              }
              if (supported) for (const path of paths) (simple[1] === 'touch' ? created : deleted).add(path);
            }
          }
        }
      }
    }
  }

  // Precedence rule:
  // 1. If a file was deleted, remove it from created and edited
  for (const f of deleted) {
    created.delete(f);
    edited.delete(f);
  }
  // 2. If a file was created and also edited in the same turn, classify as created
  for (const f of created) {
    edited.delete(f);
  }

  return {
    created: Array.from(created).sort(),
    edited: Array.from(edited).sort(),
    deleted: Array.from(deleted).sort(),
  };
}

/**
 * Extract commands executed in a turn and match with results.
 */
export function extractTurnCommands(messages: NormalizedMessage[]): TurnCommand[] {
  const commands: TurnCommand[] = [];
  const resultsByToolUseId = new Map<string, { isError: boolean; content: string; timestamp: Date }>();

  // Pass 1: collect results
  for (const msg of messages) {
    if (msg.role === 'tool_result') {
      for (const b of msg.blocks) {
        if (b.type === 'tool_result' && b.toolUseId) {
          resultsByToolUseId.set(b.toolUseId, {
            isError: Boolean(b.isError),
            content: b.content || '',
            timestamp: msg.timestamp,
          });
        }
      }
    }
  }

  // Pass 2: match tool_use commands
  for (const msg of messages) {
    if (msg.role === 'tool_use') {
      for (const b of msg.blocks) {
        if (b.type === 'tool_use') {
          const name = b.name.toLowerCase();
          const inp = b.input || {};

          const isCommandTool =
            ['bash', 'exec_command', 'run_command', 'execute_command', 'execute', 'shell', 'terminal'].includes(name) ||
            (name === 'exec' && (inp.tool === 'exec_command' || typeof inp.command === 'string'));

          if (isCommandTool) {
            const cmd = joinCommand(inp.command, inp.CommandLine, inp.cmd, inp.script);
            if (!cmd) continue;

            const res = resultsByToolUseId.get(b.id);
            let exitCode: number | undefined = undefined;
            let isError = false;
            let durationMs: number | undefined;

            if (res) {
              isError = res.isError;
              if (res.timestamp && msg.timestamp) {
                const diff = res.timestamp.getTime() - msg.timestamp.getTime();
                if (diff >= 0) durationMs = diff;
              }

              // Attempt JSON parsing of exit_code
              try {
                const parsed = JSON.parse(res.content);
                if (typeof parsed?.exit_code === 'number') {
                  exitCode = parsed.exit_code;
                } else if (typeof parsed?.exitCode === 'number') {
                  exitCode = parsed.exitCode;
                } else if (typeof parsed?.returncode === 'number') {
                  exitCode = parsed.returncode;
                }
              } catch {
                // Regex fallback on text output
                const match = res.content.match(/(?:exit code|exited with code)[\s:=]*(-?\d+)/i);
                if (match) {
                  exitCode = parseInt(match[1], 10);
                }
              }

              if (exitCode === undefined && !isError) exitCode = 0;

              if (exitCode !== undefined) {
                isError = isError || exitCode !== 0;
              }
            }

            const startedAtStr = safeIsoString(msg.timestamp) || undefined;
            commands.push({
              cmd,
              exitCode,
              isError,
              startedAt: startedAtStr,
              durationMs,
              exit_code: exitCode,
              is_error: isError,
              started_at: startedAtStr,
              duration_ms: durationMs,
            });
          }
        }
      }
    }
  }

  return commands;
}

/**
 * Extract token usage for a turn.
 */
export function extractTurnUsage(messages: NormalizedMessage[]): TurnUsage | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let contextTokens = 0;
  let hasUsage = false;

  for (const m of messages) {
    const u = (m as any).usage;
    if (u) {
      hasUsage = true;
      if (typeof u.input_tokens === 'number') input += u.input_tokens;
      if (typeof u.output_tokens === 'number') output += u.output_tokens;
      if (typeof u.cache_read_input_tokens === 'number') cacheRead += u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number') cacheWrite += u.cache_creation_input_tokens;
      if (typeof u.context_tokens === 'number') contextTokens = u.context_tokens;
    }
    if (typeof (m as any).contextTokens === 'number') {
      contextTokens = (m as any).contextTokens;
      hasUsage = true;
    }
  }

  if (!hasUsage) return undefined;
  return {
    input,
    output,
    cacheRead: cacheRead || undefined,
    cacheWrite: cacheWrite || undefined,
    contextTokens: contextTokens || (input + cacheRead),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead || undefined,
    cacheWriteTokens: cacheWrite || undefined,
  };
}

/**
 * Extract all turn execution facts.
 */
export function extractTurnFacts(messages: NormalizedMessage[], sessionMessages: NormalizedMessage[] | Map<string, NormalizedMessage> = messages): TurnExecutionFacts {
  const callIds = new Set(messages.flatMap(m => m.blocks.filter(b => b.type === 'tool_use').map(b => b.id)));
  const turnIndices = new Set(messages.map(m => m.index));
  const ownedMessages = messages.filter(m => m.role !== 'tool_result' || m.blocks.some(b => b.type === 'tool_result' && callIds.has(b.toolUseId)));
  const resultsById = sessionMessages instanceof Map ? sessionMessages : new Map(sessionMessages.flatMap(m => m.blocks.flatMap(b => b.type === 'tool_result' ? [[b.toolUseId, m] as const] : [])));
  const lateResults = [...callIds].flatMap(id => { const m = resultsById.get(id); return m && !turnIndices.has(m.index) ? [m] : []; });
  const executionMessages = [...ownedMessages, ...lateResults];
  const filesChanged = extractTurnFilesChanged(executionMessages);
  const commands = extractTurnCommands(executionMessages);
  const pendingToolCalls = findTurnPendingToolCalls(executionMessages);

  // Count distinct failing executions; a failed command result counts only once.
  const commandIds = new Set(executionMessages.flatMap(m => m.blocks.filter(b => b.type === 'tool_use' &&
    ['bash', 'exec_command', 'run_command', 'execute_command', 'execute', 'shell', 'terminal', 'exec'].includes(b.name.toLowerCase())).flatMap(b => b.type === 'tool_use' ? [b.id] : [])));
  const failingIds = new Set<string>();
  for (const m of executionMessages) for (const b of m.blocks) {
    if (b.type !== 'tool_result') continue;
    if (b.isError || (commandIds.has(b.toolUseId) && /(?:exit code|exited with code)[\s:=]*(-?[1-9]\d*)/i.test(b.content))) failingIds.add(b.toolUseId);
  }
  // Include statuses encoded as JSON or other formats supported by command extraction.
  const errorCount = Math.max(commands.filter(c => c.isError).length,
    [...failingIds].filter(id => commandIds.has(id)).length) + [...failingIds].filter(id => !commandIds.has(id)).length;

  // Duration
  let durationMs: number | undefined;
  for (const m of messages) {
    if ((m.kind === 'turn_duration' || m.terminal !== undefined) && typeof m.durationMs === 'number') {
      durationMs = m.durationMs;
      break;
    }
    if (m.kind === 'turn_duration' && typeof (m as any).duration_ms === 'number') {
      durationMs = (m as any).duration_ms;
      break;
    }
  }

  if (durationMs === undefined && messages.length > 1) {
    const tStart = messages[0].timestamp?.getTime();
    const tEnd = messages[messages.length - 1].timestamp?.getTime();
    if (tStart !== undefined && tEnd !== undefined && tEnd >= tStart) {
      durationMs = tEnd - tStart;
    }
  }

  if (durationMs === undefined) {
    durationMs = 0;
  }

  return {
    filesChanged,
    commands,
    errorCount,
    durationMs,
    pendingToolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
    files_changed: filesChanged,
    error_count: errorCount,
    duration_ms: durationMs,
    pending_tool_calls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
  };
}

/**
 * Claude keeps each turn's reported duration in session.turnEnds (system records are not messages), so a
 * turn owns the ends whose physical line sits between its prompt and the next prompt.
 */
function reportedTurnDuration(
  turnEnds: TurnEndEvent[] | undefined,
  firstRawLine: number | undefined,
  nextRawLine: number | undefined,
): number | undefined {
  if (!turnEnds?.length || firstRawLine === undefined) return undefined;
  const owned = turnEnds.filter(
    (e) => e.rawLineIndex >= firstRawLine && (nextRawLine === undefined || e.rawLineIndex < nextRawLine),
  );
  return owned.length > 0 ? owned.reduce((sum, e) => sum + e.durationMs, 0) : undefined;
}

/**
 * Segment a session into discrete Turn objects.
 */
export function segmentTurns(
  sessionOrMessages: NormalizedSession | NormalizedMessage[],
  metadata?: SessionMetadata,
): Turn[] {
  const messages = Array.isArray(sessionOrMessages)
    ? sessionOrMessages
    : sessionOrMessages.messages;
  const meta = Array.isArray(sessionOrMessages)
    ? metadata
    : (sessionOrMessages.metadata || metadata);
  const turnEnds = Array.isArray(sessionOrMessages) ? undefined : sessionOrMessages.turnEnds;

  if (!messages || messages.length === 0) {
    if (!Array.isArray(sessionOrMessages)) {
      sessionOrMessages.turns = [];
    }
    return [];
  }

  // Identify all genuine prompt boundaries
  const promptIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isGenuinePrompt(messages[i])) {
      promptIndices.push(i);
    }
  }

  if (promptIndices.length === 0) {
    if (!Array.isArray(sessionOrMessages)) {
      sessionOrMessages.turns = [];
    }
    return [];
  }

  const turns: Turn[] = [];
  const resultsById = new Map(messages.flatMap(m => m.blocks.flatMap(b => b.type === 'tool_result' ? [[b.toolUseId, m] as const] : [])));

  for (let i = 0; i < promptIndices.length; i++) {
    const startPos = promptIndices[i];
    const endPos = i + 1 < promptIndices.length ? promptIndices[i + 1] : messages.length;
    const turnMessages = messages.slice(startPos, endPos);
    const promptMsg = messages[startPos];
    const turnIndex = i + 1;
    const id = `turn-${turnIndex}`;
    const startIndex = promptMsg.index;
    const endIndex = messages[endPos - 1].index;

    const interrupted = turnMessages.some(
      (m) => m.terminal === 'interrupted' || m.source === 'interrupt' ||
        (m.role === 'user' && /^(?:\[Request interrupted by user(?: for tool use(?: "[^"]+")?)?\]|User interrupted execution)/.test(m.content.trim())),
    );

    const facts = extractTurnFacts(turnMessages, resultsById);

    const reported = reportedTurnDuration(
      turnEnds,
      promptMsg.rawLineIndex,
      i + 1 < promptIndices.length ? messages[promptIndices[i + 1]].rawLineIndex : undefined,
    );
    if (reported !== undefined) {
      facts.durationMs = reported;
      facts.duration_ms = reported;
    }
    let durationMs = facts.durationMs;
    if (durationMs === undefined && turnMessages.length > 1) {
      const t0 = promptMsg.timestamp?.getTime?.() ?? 0;
      const t1 = messages[endPos - 1].timestamp?.getTime?.() ?? 0;
      if (t1 >= t0 && t0 > 0) {
        durationMs = t1 - t0;
      }
    }
    if (durationMs === undefined) {
      durationMs = 0;
    }

    const hasPending = Boolean(facts.pendingToolCalls?.length);
    const finalAssistant = [...turnMessages].reverse().find((m) => m.role === 'assistant' && m.kind !== 'commentary');
    const terminal = [...turnMessages].reverse().find((m) => m.terminal !== undefined)?.terminal;
    const lastActivity = turnMessages[turnMessages.length - 1];
    const completed = !interrupted && !hasPending && (terminal === 'complete' ||
      (terminal === undefined && finalAssistant !== undefined && lastActivity.role === 'assistant'));

    const usage = extractTurnUsage(turnMessages);
    const model = meta?.model;
    const contextWindowSize = deriveContextWindow(model, meta);
    const reasoningEffort = meta?.reasoningEffort;

    // Look for rate limits attached to any message in this turn
    let rateLimits: CodexRateLimits | undefined;
    for (const m of turnMessages) {
      if ((m as any).rateLimits) {
        rateLimits = (m as any).rateLimits;
      }
    }

    const turn: Turn = {
      id,
      turnIndex,
      userMessageId: promptMsg.index,
      startIndex,
      endIndex,
      prompt: {
        text: promptMsg.content,
        source: promptMsg.source ?? 'prompt',
        timestamp:
          promptMsg.timestamp instanceof Date && !isNaN(promptMsg.timestamp.getTime())
            ? promptMsg.timestamp.toISOString()
            : undefined,
      },
      finalMessageIndex: finalAssistant?.index ?? startIndex,
      completed,
      interrupted,
      durationMs,
      filesChanged: facts.filesChanged,
      commands: facts.commands,
      errorCount: facts.errorCount,
      pendingToolCalls: facts.pendingToolCalls,
      facts,
      usage,
      model,
      contextWindowSize,
      contextWindow: contextWindowSize,
      reasoningEffort,
      rateLimits,
    };

    turns.push(turn);
  }

  // Attach turns if a NormalizedSession object was passed
  if (!Array.isArray(sessionOrMessages)) {
    sessionOrMessages.turns = turns;
  }

  return turns;
}

/**
 * Retrieve a specific turn by 1-based index, id string, or "last".
 */
export function getTurn(
  sessionOrTurns: NormalizedSession | Turn[] | NormalizedMessage[],
  idOrIndex: string | number,
): Turn {
  let turns: Turn[];
  if (Array.isArray(sessionOrTurns)) {
    if (sessionOrTurns.length === 0) {
      turns = [];
    } else if ('prompt' in sessionOrTurns[0] && 'id' in sessionOrTurns[0]) {
      turns = sessionOrTurns as Turn[];
    } else {
      turns = segmentTurns(sessionOrTurns as NormalizedMessage[]);
    }
  } else {
    turns = sessionOrTurns.turns ?? segmentTurns(sessionOrTurns);
  }

  if (!turns || turns.length === 0) {
    throw new SessionReaderError('No turns found in session', {
      code: 'TURN_NOT_FOUND',
      exitCode: EXIT.USAGE,
      errorClass: 'validation',
    });
  }

  if (idOrIndex === 'last') {
    return turns[turns.length - 1];
  }

  if (typeof idOrIndex === 'number') {
    if (!Number.isInteger(idOrIndex) || idOrIndex < 1 || idOrIndex > turns.length) {
      throw new SessionReaderError(`Turn index ${idOrIndex} out of bounds (1..${turns.length})`, {
        code: 'TURN_NOT_FOUND',
        exitCode: EXIT.USAGE,
        errorClass: 'validation',
        detail: { requestedIndex: idOrIndex, totalTurns: turns.length },
      });
    }
    return turns[idOrIndex - 1];
  }

  if (typeof idOrIndex === 'string') {
    const trimmed = idOrIndex.trim().toLowerCase();
    if (trimmed === 'last') {
      return turns[turns.length - 1];
    }
    const match = trimmed.match(/^(?:turn-)?(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx >= 1 && idx <= turns.length) {
        return turns[idx - 1];
      }
    }
    const found = turns.find((t) => t.id === idOrIndex || t.id.toLowerCase() === trimmed);
    if (found) return found;
  }

  throw new SessionReaderError(`Turn "${idOrIndex}" not found in session`, {
    code: 'TURN_NOT_FOUND',
    exitCode: EXIT.USAGE,
    errorClass: 'validation',
    detail: { requested: idOrIndex, totalTurns: turns.length },
  });
}
