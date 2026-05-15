import { describe, it, expect } from 'vitest';
import { ellipsize, findSearchMatches } from '../src/search-snippets.js';
import type { NormalizedMessage } from '../src/types.js';

describe('search snippets', () => {
  it('centers snippets around the hit and caps length', () => {
    const text = `${'alpha '.repeat(20)}deploy ${'omega '.repeat(20)}`;
    const snippet = ellipsize(text, 120, text.indexOf('deploy'));

    expect(snippet).toContain('deploy');
    expect(snippet.length).toBeLessThanOrEqual(120);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns message index, snippet, and char offset for up to three sessions hits', () => {
    const messages = Array.from({ length: 4 }, (_, index): NormalizedMessage => ({
      index: index + 1,
      role: 'assistant',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: `message ${index + 1} includes deploy context`,
      blocks: [{ type: 'text', text: `message ${index + 1} includes deploy context` }],
    }));

    const matches = findSearchMatches(messages, 'deploy');

    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({
      messageIndex: 1,
      snippet: 'message 1 includes deploy context',
      charOffset: 19,
    });
  });
});
