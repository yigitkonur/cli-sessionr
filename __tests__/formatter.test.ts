import { describe, it, expect } from 'vitest';
import {
  createFormatter,
  ACCEPTED_OUTPUT_FORMATS,
  isAcceptedOutputFormat,
} from '../src/output/formatter.js';
import { SessionReaderError, EXIT } from '../src/errors.js';
import type { OutputFormat } from '../src/types.js';

describe('isAcceptedOutputFormat()', () => {
  it.each(ACCEPTED_OUTPUT_FORMATS)('accepts canonical format %s', (fmt) => {
    expect(isAcceptedOutputFormat(fmt)).toBe(true);
  });

  it.each(['xml', 'yaml', 'csv', '', 'JSON', 'JSONL', null, undefined, 42])(
    'rejects bogus value %s',
    (bad) => {
      expect(isAcceptedOutputFormat(bad)).toBe(false);
    },
  );
});

describe('createFormatter() — oc/03 validation', () => {
  it('throws INVALID_OUTPUT for unknown --output values', () => {
    expect(() =>
      createFormatter({ output: 'xml' as unknown as OutputFormat, isTTY: false }),
    ).toThrow(SessionReaderError);
  });

  it('error carries USAGE exit code, validation class, and accepted-list detail', () => {
    let caught: SessionReaderError | undefined;
    try {
      createFormatter({ output: 'csv' as unknown as OutputFormat, isTTY: false });
    } catch (err) {
      caught = err as SessionReaderError;
    }
    expect(caught).toBeInstanceOf(SessionReaderError);
    expect(caught!.code).toBe('INVALID_OUTPUT');
    expect(caught!.exitCode).toBe(EXIT.USAGE);
    expect(caught!.class).toBe('validation');
    expect(caught!.detail.provided).toBe('csv');
    expect(caught!.detail.accepted).toEqual(['json', 'jsonl', 'text', 'table']);
    expect(caught!.suggestion).toContain('--output');
  });

  it('does not throw when --output is omitted (default resolution applies)', () => {
    expect(() => createFormatter({ isTTY: false })).not.toThrow();
  });

  it.each(ACCEPTED_OUTPUT_FORMATS)('accepts %s without throwing', (fmt) => {
    expect(() => createFormatter({ output: fmt, isTTY: false })).not.toThrow();
  });

  it('still routes valid formats to a working formatter (smoke test)', () => {
    const jsonl = createFormatter({ output: 'jsonl', isTTY: false });
    expect(typeof jsonl.list).toBe('function');
    expect(typeof jsonl.error).toBe('function');
  });
});

describe('ACCEPTED_OUTPUT_FORMATS', () => {
  it('matches the OutputFormat union exactly (no drift)', () => {
    expect([...ACCEPTED_OUTPUT_FORMATS].sort()).toEqual(
      ['json', 'jsonl', 'table', 'text'].sort(),
    );
  });
});
