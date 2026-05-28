import type { PresetName, VerbosityPreset, OutputFormat, DetailLevel } from './types.js';
import { EXIT, SessionReaderError } from './errors.js';

const MINIMAL: VerbosityPreset = {
  name: 'minimal',
  maxContentChars: 80,
  maxToolInputChars: 0,
  maxToolResultChars: 0,
  showThinking: false,
  maxThinkingChars: 0,
  showToolArgs: false,
  showToolResults: false,
};

const STANDARD: VerbosityPreset = {
  name: 'standard',
  maxContentChars: 500,
  maxToolInputChars: 60,
  maxToolResultChars: 80,
  showThinking: false,
  maxThinkingChars: 0,
  showToolArgs: true,
  showToolResults: true,
};

const VERBOSE: VerbosityPreset = {
  name: 'verbose',
  maxContentChars: 2000,
  maxToolInputChars: 200,
  maxToolResultChars: 500,
  showThinking: true,
  maxThinkingChars: 200,
  showToolArgs: true,
  showToolResults: true,
};

const FULL: VerbosityPreset = {
  name: 'full',
  maxContentChars: Infinity,
  maxToolInputChars: Infinity,
  maxToolResultChars: Infinity,
  showThinking: true,
  maxThinkingChars: Infinity,
  showToolArgs: true,
  showToolResults: true,
};

const PRESETS: Record<PresetName, VerbosityPreset> = {
  minimal: MINIMAL,
  standard: STANDARD,
  verbose: VERBOSE,
  full: FULL,
};

export function getPreset(name: string): VerbosityPreset {
  const preset = PRESETS[name as PresetName];
  if (!preset) {
    // er/05: structured INVALID_PRESET error so callers see a typed v2
    // envelope (validation class, USAGE exit) instead of a bare Error.
    throw new SessionReaderError(`Unknown verbosity preset "${name}"`, {
      code: 'INVALID_PRESET',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
      detail: { provided: name, valid: Object.keys(PRESETS) },
      suggestion: 'sessionr read <id> --preset standard',
    });
  }
  return preset;
}

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

// ── Detail Level → Preset Mapping ──────────────────────────────────────────

const DETAIL_TO_PRESET: Record<DetailLevel, PresetName> = {
  full: 'full',
  condensed: 'standard',
  skeleton: 'minimal',
  meta: 'minimal',
};

export function getPresetForDetail(detail: DetailLevel): VerbosityPreset {
  const presetName = DETAIL_TO_PRESET[detail];
  if (!presetName) {
    throw new SessionReaderError(`Unknown detail level "${detail}"`, {
      code: 'INVALID_DETAIL',
      errorClass: 'validation',
      exitCode: EXIT.USAGE,
      detail: { provided: detail, valid: DETAIL_LEVELS },
      suggestion: 'sessionr read <id> --detail condensed',
    });
  }
  return PRESETS[presetName];
}

export const DETAIL_LEVELS: DetailLevel[] = ['full', 'condensed', 'skeleton', 'meta'];

// ── Environment Variable Defaults ──────────────────────────────────────────

const TTY_DEFAULT_TOKEN_BUDGET = 8_000;
const AGENT_DEFAULT_TOKEN_BUDGET = 8_000;
export const MAX_CHUNK_BUDGET = 8_000;

export function getDefaultTokenBudget(): number {
  const env = process.env.SESSIONREADER_MAX_TOKENS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_CHUNK_BUDGET);
  }
  if (process.stdout.isTTY) return TTY_DEFAULT_TOKEN_BUDGET;
  return AGENT_DEFAULT_TOKEN_BUDGET;
}

export function getDefaultPresetName(isTTY: boolean): PresetName {
  // Agents get verbose by default (more context); TTY humans get standard
  return isTTY ? 'standard' : 'verbose';
}

export function getDefaultOutputFormat(): OutputFormat | undefined {
  const env = process.env.SESSIONREADER_OUTPUT;
  if (!env) return undefined;
  const valid: OutputFormat[] = ['json', 'jsonl', 'table', 'text'];
  return valid.includes(env as OutputFormat) ? (env as OutputFormat) : undefined;
}

export function resolveOutputFormat(opts: {
  output?: OutputFormat;
  json?: boolean;
  isTTY: boolean;
}): OutputFormat {
  if (opts.output) return opts.output;
  if (opts.json) return 'json';
  const envDefault = getDefaultOutputFormat();
  if (envDefault) return envDefault;
  return opts.isTTY ? 'text' : 'json';
}
