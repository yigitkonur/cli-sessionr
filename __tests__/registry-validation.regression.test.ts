import { describe, it, expect } from 'vitest';
import { getAdapter, getAdapters, listSessions } from '../src/index.js';

describe('Registry source validation', () => {
  it('rejects unknown adapter names instead of hiding validation errors', () => {
    expect(() => getAdapter('not-a-registered-source')).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }));
    expect(() => getAdapters('not-a-registered-source')).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }));
  });

  it('rejects unknown discovery sources instead of returning no sessions', async () => {
    await expect(listSessions('not-a-registered-source' as 'claude')).rejects.toMatchObject({
      code: 'INVALID_SOURCE', class: 'validation',
    });
  });
});
