// Canonical v2 envelope contract for sessionr v3.
//
// Every command in v3 produces an envelope built via success() or failure().
// The shape is intentionally open under `meta` so individual commands can
// extend it with command-specific fields (etag, range, cursor, etc.).
//
// Routing/serialization is owned by `./emit.ts`; this module is pure data.

export const SCHEMA_VERSION = 'v2' as const;

export type ErrorClass =
  | 'validation'
  | 'not_found'
  | 'auth'
  | 'rate_limit'
  | 'internal'
  | 'partial';

export interface V2Error {
  class: ErrorClass;
  /** Stable identifier, e.g. SESSION_NOT_FOUND. */
  code: string;
  message: string;
  detail?: Record<string, unknown>;
  suggestion?: string;
  /** Renamed from legacy `retry` for clarity. */
  retryable: boolean;
}

export interface V2Action {
  command: string;
  description: string;
}

export interface V2Meta {
  cwd_scope?: 'auto' | 'fellback_to_global' | 'all' | 'explicit';
  cwd?: string;
  etag?: string;
  timing_ms?: number;
  // Open shape; commands extend as needed.
  [key: string]: unknown;
}

export interface V2Envelope<T = unknown> {
  ok: boolean;
  schema_version: typeof SCHEMA_VERSION;
  result?: T;
  error?: V2Error;
  meta?: V2Meta;
  actions?: V2Action[];
}

/**
 * Build a successful envelope. Always sets ok:true, schema_version:'v2',
 * and `result`. Never sets `error`.
 */
export function success<T>(
  result: T,
  opts?: { meta?: V2Meta; actions?: V2Action[] },
): V2Envelope<T> {
  const env: V2Envelope<T> = {
    ok: true,
    schema_version: SCHEMA_VERSION,
    result,
  };
  if (opts?.meta !== undefined) env.meta = opts.meta;
  if (opts?.actions !== undefined) env.actions = opts.actions;
  return env;
}

/**
 * Build a failure envelope. Always sets ok:false, schema_version:'v2',
 * and `error`. Never sets `result`.
 */
export function failure(
  error: V2Error,
  opts?: { meta?: V2Meta; actions?: V2Action[] },
): V2Envelope<never> {
  const env: V2Envelope<never> = {
    ok: false,
    schema_version: SCHEMA_VERSION,
    error,
  };
  if (opts?.meta !== undefined) env.meta = opts.meta;
  if (opts?.actions !== undefined) env.actions = opts.actions;
  return env;
}
