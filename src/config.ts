import type { PresetName, VerbosityPreset, OutputFormat, DetailLevel } from './types.js';

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
    throw new Error(
      `Unknown verbosity preset "${name}". Valid presets: ${Object.keys(PRESETS).join(', ')}`,
    );
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
  return PRESETS[DETAIL_TO_PRESET[detail]];
}

export const DETAIL_LEVELS: DetailLevel[] = ['full', 'condensed', 'skeleton', 'meta'];

// ── Environment Variable Defaults ──────────────────────────────────────────

export function getDefaultTokenBudget(): number | undefined {
  const env = process.env.SESSIONREADER_MAX_TOKENS;
  if (!env) return undefined;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
