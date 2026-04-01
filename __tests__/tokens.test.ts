import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens, estimateSessionTokens } from '../src/tokens.js';
import type { NormalizedMessage } from '../src/types.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates prose at ~4 chars/token', () => {
    const text = 'Hello, welcome to our application please enter your email';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    // ceil(57/4) = 15, expected ~14.25 — within reasonable range
    const expected = Math.ceil(text.length / 4);
    expect(Math.abs(tokens - expected)).toBeLessThanOrEqual(1);
  });

  it('estimates code at ~3.5 chars/token', () => {
    const code = 'function foo() {\n  const x = bar();\n  return x > 0 ? x : -x;\n}';
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(code.length / 4);
  });

  it('handles null/undefined gracefully', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  it('includes overhead for message framing', () => {
    const msg: NormalizedMessage = {
      index: 1,
      role: 'user',
      timestamp: new Date(),
      content: 'Hi',
      blocks: [{ type: 'text', text: 'Hi' }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThanOrEqual(5); // 4 overhead + at least 1 for content
  });

  it('counts tool_use blocks including input', () => {
    const msg: NormalizedMessage = {
      index: 1,
      role: 'tool_use',
      timestamp: new Date(),
      content: 'Read',
      blocks: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/src/index.ts' } }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(4);
  });

  it('counts tool_result blocks', () => {
    const msg: NormalizedMessage = {
      index: 1,
      role: 'tool_result',
      timestamp: new Date(),
      content: 'file contents here',
      blocks: [{ type: 'tool_result', toolUseId: 'tu1', content: 'file contents here with lots of data', isError: false }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(4);
  });
});

describe('estimateSessionTokens', () => {
  it('sums all message tokens', () => {
    const messages: NormalizedMessage[] = [
      { index: 1, role: 'user', timestamp: new Date(), content: 'Hello', blocks: [{ type: 'text', text: 'Hello' }] },
      { index: 2, role: 'assistant', timestamp: new Date(), content: 'Hi there', blocks: [{ type: 'text', text: 'Hi there' }] },
    ];
    const total = estimateSessionTokens(messages);
    const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(total).toBe(sum);
  });

  it('returns 0 for empty array', () => {
    expect(estimateSessionTokens([])).toBe(0);
  });
});
