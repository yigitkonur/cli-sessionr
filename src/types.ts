// ── Re-exports (v2 envelope contract) ──────────────────────────────────────
// Callers may import these directly from './output/envelope.js'; re-exported
// here so the rest of the codebase can keep a single import target.
export type {
  ErrorClass,
  V2Action,
  V2Envelope,
  V2Error,
  V2Meta,
} from './output/envelope.js';
export { SCHEMA_VERSION, success, failure } from './output/envelope.js';

// ── Source Types ────────────────────────────────────────────────────────────

export type SessionSource =
  | 'codex' | 'claude'
  | 'gemini' | 'copilot' | 'cursor-agent' | 'commandcode'
  | 'goose' | 'opencode' | 'kiro' | 'zed'
  | 'factory';

// ── Content Blocks ─────────────────────────────────────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

// ── Normalized Message ─────────────────────────────────────────────────────

export interface NormalizedMessage {
  /** 1-based position after normalization (tool blocks exploded into separate entries) */
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  timestamp: Date;
  /** Primary text content (joined from text blocks, or tool summary) */
  content: string;
  /** All content blocks for rich rendering */
  blocks: ContentBlock[];
  /** Original JSONL line number for debugging */
  rawLineIndex?: number;
}

// ── Session Metadata ───────────────────────────────────────────────────────

export interface SessionMetadata {
  cwd: string;
  gitBranch?: string;
  gitRepo?: string;
  model?: string;
  createdAt: Date;
  updatedAt: Date;
  fileBytes: number;
  rawLineCount: number;
}

// ── Session Stats ──────────────────────────────────────────────────────────

export interface SessionStats {
  totalMessages: number;
  byRole: {
    user: number;
    assistant: number;
    system: number;
    toolUse: number;
    toolResult: number;
  };
  byBlockType: Record<string, number>;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
    thinking?: number;
  };
  toolFrequency: Array<{ name: string; count: number; errors: number }>;
  filesModified: string[];
  durationMs?: number;
}

// ── Normalized Session ─────────────────────────────────────────────────────

export interface NormalizedSession {
  id: string;
  source: SessionSource;
  filePath: string;
  metadata: SessionMetadata;
  messages: NormalizedMessage[];
  stats: SessionStats;
}

// ── Session List Entry (lightweight, for list command) ─────────────────────

export interface SessionListEntry {
  id: string;
  source: SessionSource;
  cwd: string;
  updatedAt: Date;
  summary?: string;
  filePath: string;
  /** True when the session contains no user/assistant messages (e.g. Factory "New Session"). */
  isEmpty?: boolean;
}

export type CwdScope = 'auto' | 'fellback_to_global' | 'all' | 'explicit';

export interface CwdScopeMeta {
  cwd_scope: CwdScope;
  cwd: string;
  reason?: string;
}

export interface DiscoveryWarning {
  source: SessionSource;
  error: {
    code: string;
    message: string;
  };
}

// ── Verbosity Preset ───────────────────────────────────────────────────────

export type PresetName = 'minimal' | 'standard' | 'verbose' | 'full';

export interface VerbosityPreset {
  name: PresetName;
  maxContentChars: number;
  maxToolInputChars: number;
  maxToolResultChars: number;
  showThinking: boolean;
  maxThinkingChars: number;
  showToolArgs: boolean;
  showToolResults: boolean;
}

// ── Formatter Interface ────────────────────────────────────────────────────

export interface Formatter {
  stats(session: NormalizedSession): string;
  read(
    session: NormalizedSession,
    messages: NormalizedMessage[],
    from: number,
    to: number,
    preset: VerbosityPreset,
    meta?: SliceMeta,
  ): string;
  list(entries: SessionListEntry[], meta?: ListFooterMeta): string;
  error(err: Error): string;
}

// ── Output Format ──────────────────────────────────────────────────────────

export type OutputFormat = 'json' | 'jsonl' | 'table' | 'text';

// ── Detail Levels ──────────────────────────────────────────────────────────

export type DetailLevel = 'full' | 'condensed' | 'skeleton' | 'meta';

// ── Session Summary (embedded in read response) ────────────────────────────

export interface SessionSummary {
  id: string;
  source: SessionSource;
  model?: string;
  cwd: string;
  git_branch?: string;
  total_messages: number;
  total_tokens_estimate: number;
  pages_estimate: number;
  duration?: string;
  by_role: {
    user: number;
    assistant: number;
    system: number;
    tool_use: number;
    tool_result: number;
  };
}

// ── Cursor Commands (copy-paste ready + machine-readable tokens) ──────────

export interface CursorCommand {
  command: string;
  offset: number;
  limit: number;
}

export interface CursorCommands {
  next: CursorCommand | null;
  prev: CursorCommand | null;
  first: CursorCommand | null;
}

// ── List Footer Metadata ──────────────────────────────────────────────────

export interface ListFooterMeta {
  totalAvailable: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  source?: string;
}

// ── Slice Metadata (pagination envelope) ───────────────────────────────────

export interface SliceMeta {
  session_id: string;
  source: SessionSource;
  etag?: string;
  total_messages: number;
  total_tokens_estimate: number;
  returned_tokens_estimate: number;
  token_budget: number | null;
  anchor: 'head' | 'tail' | 'search' | 'page' | null;
  range: { from: number; to: number };
  has_more_before: boolean;
  has_more_after: boolean;
  partial?: boolean;
  cursor_before: number | null;
  cursor_after: number | null;
  cursor: CursorCommands;
  page?: { current: number; total: number };
  budget?: number | null;
  preset?: string;
  next_action?: {
    resume: string;
    resume_async: string;
    direct: string | null;
    verified: boolean;
    /** it/12: true when the spawn binary for `source` is actually on PATH. */
    runtime_bin_available?: boolean;
    tip: string;
  };
  detail_hint?: {
    current_preset: string;
    /** it/06: estimated tokens for the CURRENT preset (so agents can compare
     * against upgrade_options without re-summing). */
    current_estimated_tokens?: number;
    /** it/06: true when the current preset's render fits inside token_budget. */
    current_will_fit_in_budget?: boolean;
    hidden_tool_calls: number;
    truncated_results: number;
    thinking_hidden: boolean;
    upgrade_options: Array<{
      preset: string;
      estimated_tokens: number;
      will_fit_in_current_budget: boolean;
      delta_vs_current_tokens: number;
      command: string;
    }>;
  };
}

// ── Output Resolution Options ──────────────────────────────────────────────

export interface OutputOptions {
  output?: OutputFormat;
  json?: boolean;
  isTTY: boolean;
  apiVersion?: number;
}

// ── Read Command Options ───────────────────────────────────────────────────

export interface ReadOptions {
  source?: string;
  preset?: string;
  detail?: DetailLevel;
  json?: boolean;
  output?: OutputFormat;
  tokens?: number;
  anchor?: string;
  search?: string;
  role?: string;
  before?: number;
  after?: number;
  ifChanged?: string;
  page?: number;
  includeSummary?: boolean;
  batch?: string;
  /** Phase 1 carry-forward: forwarded from cli.ts so meta.timing_ms appears. */
  timing?: boolean;
}

// ── Job Types (Write Path) ─────────────────────────────────────────────────

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  session_id: string | null;
  source: SessionSource;
  read_back: {
    source: SessionSource;
    tokens?: number;
    preset?: string;
  };
  cwd: string;
  message: string;
  status: JobStatus;
  pid: number;
  exit_code: number | null;
  started_at: string;
  completed_at: string | null;
  message_count_before: number;
  stdout_file: string;
  stderr_file: string;
  is_new_session: boolean;
  last_error?: string | null;
}

export interface SendOptions {
  source?: string;
  /** Inline prompt; mutually exclusive with `file`. Validated in sendCommand. */
  message?: string;
  /** Path to a file whose contents form the prompt; validated in sendCommand. */
  file?: string;
  async?: boolean;
  new?: boolean;
  cwd?: string;
  output?: OutputFormat;
  tokens?: number;
  preset?: string;
  /** Forwarded from cli.ts so meta.timing_ms appears, like every other command. */
  timing?: boolean;
}
