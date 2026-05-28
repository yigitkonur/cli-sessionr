// Canonical write-out for v2 envelopes.
//
// Routing rule (oc/04 fix): in JSON/JSONL modes ALL envelopes — success OR
// failure — go to STDOUT. STDERR is reserved for operator log lines (none
// from emit() today). Text/table modes fall back to a pretty-printed JSON
// dump until Phase 1 ships dedicated renderers; this keeps the contract
// honest without breaking pre-migration callers.
//
// Timing: `markStart()` records process boot once; `emit({timing:true})`
// injects `meta.timing_ms` (rounded integer milliseconds elapsed) before
// serialization. Per-command timing isolation is not a goal — wall time
// since CLI boot matches what users perceive.

import type { V2Envelope, V2Meta } from './envelope.js';
import type { OutputFormat } from '../types.js';

export interface EmitOptions {
  format?: OutputFormat;
  isTTY?: boolean;
  timing?: boolean;
  exitCode?: number;
}

let startNs: bigint | null = null;

/** Call once at CLI boot to anchor --timing measurements. */
export function markStart(): void {
  startNs = process.hrtime.bigint();
}

function elapsedMs(): number {
  if (startNs === null) return 0;
  const deltaNs = process.hrtime.bigint() - startNs;
  // Round-half-up to integer ms.
  return Number((deltaNs + 500_000n) / 1_000_000n);
}

function withTiming<T>(envelope: V2Envelope<T>): V2Envelope<T> {
  const meta: V2Meta = { ...(envelope.meta ?? {}) };
  meta.timing_ms = elapsedMs();
  return { ...envelope, meta };
}

export function emit<T>(envelope: V2Envelope<T>, opts: EmitOptions = {}): void {
  const out = opts.timing ? withTiming(envelope) : envelope;
  const format: OutputFormat = opts.format ?? 'json';

  let serialized: string;
  switch (format) {
    case 'jsonl':
      serialized = JSON.stringify(out) + '\n';
      break;
    case 'json':
    case 'text':
    case 'table':
    default:
      // text/table fall back to pretty JSON in Phase 0; Phase 1+ adds real
      // renderers. Keeping the fallback means no caller breaks mid-migration.
      serialized = JSON.stringify(out, null, 2) + '\n';
      break;
  }

  process.stdout.write(serialized);

  if (opts.exitCode !== undefined) {
    process.exitCode = opts.exitCode;
  }
}
