import { it, expect } from 'vitest';
import * as path from 'node:path';
import { read } from '../src/index.js';

it('rejects nonpositive and nonfinite token budgets before slicing', async () => {
  const file = path.resolve(__dirname, 'fixtures/claude-session.jsonl');
  for (const tokens of [0, -1, Infinity, NaN]) {
    await expect(read({ path: file, source: 'claude' }, { tokens })).rejects.toMatchObject({
      code: 'INVALID_TOKEN_BUDGET', class: 'validation',
    });
  }
});
