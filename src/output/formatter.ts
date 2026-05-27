import type { Formatter, OutputFormat } from '../types.js';
import { resolveOutputFormat } from '../config.js';
import { EXIT, SessionReaderError } from '../errors.js';
import { createJsonFormatter } from './json.js';
import { createJsonlFormatter } from './jsonl.js';
import { createPlainFormatter } from './plain.js';
import { createTtyFormatter } from './tty.js';

/**
 * The complete set of formats sessionr understands. Anything else is a
 * validation error — agents that pass `--output xml` (or any other typo)
 * should be told explicitly, not silently routed to a plain-text fallback.
 *
 * Keep this list in sync with `OutputFormat` in src/types.ts.
 */
export const ACCEPTED_OUTPUT_FORMATS: readonly OutputFormat[] = [
  'json',
  'jsonl',
  'text',
  'table',
] as const;

export function isAcceptedOutputFormat(value: unknown): value is OutputFormat {
  return (
    typeof value === 'string' &&
    (ACCEPTED_OUTPUT_FORMATS as readonly string[]).includes(value)
  );
}

export function createFormatter(opts: {
  output?: OutputFormat;
  json?: boolean;
  isTTY: boolean;
}): Formatter {
  // oc/03: reject unknown formats up-front so the v2 envelope surfaces a
  // structured INVALID_OUTPUT error (with `accepted` list + suggestion)
  // instead of silently rendering plain text. The throw propagates to
  // cli.ts's top-level catch which routes it through emit(failure(...)).
  if (opts.output !== undefined && !isAcceptedOutputFormat(opts.output)) {
    throw new SessionReaderError(
      `Invalid --output "${String(opts.output)}"; expected one of: ${ACCEPTED_OUTPUT_FORMATS.join(', ')}`,
      {
        code: 'INVALID_OUTPUT',
        exitCode: EXIT.USAGE,
        detail: {
          provided: opts.output,
          accepted: [...ACCEPTED_OUTPUT_FORMATS],
        },
        suggestion: 'Use --output json',
        retry: false,
        errorClass: 'validation',
      },
    );
  }

  const format = resolveOutputFormat(opts);

  switch (format) {
    case 'json':
      return createJsonFormatter();
    case 'jsonl':
      return createJsonlFormatter();
    case 'text':
      if (opts.isTTY && !process.env.NO_COLOR) return createTtyFormatter();
      return createPlainFormatter();
    case 'table':
      // table uses TTY formatter for now (same tabular layout)
      if (opts.isTTY && !process.env.NO_COLOR) return createTtyFormatter();
      return createPlainFormatter();
    default:
      return createPlainFormatter();
  }
}
