import { it, expect } from 'vitest';
import { getAdapter, getAdapters, registerSource } from '../src/index.js';

it('preserves aliases after a case-insensitive adapter replacement', () => {
  const original = getAdapter('factory')!;
  const replacement = { ...original, name: 'Factory' };
  try {
    registerSource(replacement);
    expect(getAdapter('factory')).toBe(replacement);
    expect(getAdapter('FACTORY')).toBe(replacement);
    expect(getAdapter('droid')).toBe(replacement);
    expect(getAdapters('DROID')).toEqual([replacement]);
  } finally {
    registerSource(original);
  }
});
