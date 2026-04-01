import type { Formatter, OutputFormat } from '../types.js';
import { resolveOutputFormat } from '../config.js';
import { createJsonFormatter } from './json.js';
import { createJsonlFormatter } from './jsonl.js';
import { createPlainFormatter } from './plain.js';
import { createTtyFormatter } from './tty.js';

export function createFormatter(opts: {
  output?: OutputFormat;
  json?: boolean;
  isTTY: boolean;
}): Formatter {
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
