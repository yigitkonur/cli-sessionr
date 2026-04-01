// ── Source Types ────────────────────────────────────────────────────────────

export type SessionSource =
  | 'codex' | 'claude'
  | 'gemini' | 'copilot' | 'cursor-agent' | 'commandcode'
  | 'goose' | 'opencode' | 'kiro' | 'zed';

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
  list(entries: SessionListEntry[]): string;
  error(err: Error): string;
}

// ── Output Format ──────────────────────────────────────────────────────────

export type OutputFormat = 'json' | 'jsonl' | 'table' | 'text';

// ── Detail Levels ──────────────────────────────────────────────────────────

export type DetailLevel = 'full' | 'condensed' | 'skeleton' | 'meta';

// ── Slice Metadata (pagination envelope) ───────────────────────────────────

export interface SliceMeta {
  session_id: string;
  source: SessionSource;
  total_messages: number;
  total_tokens_estimate: number;
  returned_tokens_estimate: number;
  token_budget: number | null;
  anchor: 'head' | 'tail' | 'search' | null;
  range: { from: number; to: number };
  has_more_before: boolean;
  has_more_after: boolean;
  cursor_before: number | null;
  cursor_after: number | null;
  next_action?: {
    description: string;
    interactive: string;
    non_interactive: string;
    verified: boolean;
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
  anchor?: 'head' | 'tail' | 'search';
  search?: string;
  role?: string;
  before?: number;
  after?: number;
  ifChanged?: string;
}

// ── Job Types (Write Path) ─────────────────────────────────────────────────

export type JobStatus = 'running' | 'completed' | 'failed';

export interface Job {
  id: string;
  session_id: string | null;
  source: SessionSource;
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
}

export interface SendOptions {
  source?: string;
  message: string;
  async?: boolean;
  new?: boolean;
  cwd?: string;
  output?: OutputFormat;
  tokens?: number;
  preset?: string;
}
