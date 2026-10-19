import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { read } from '../src/index.js';

const CLAUDE_FIXTURE = path.resolve(__dirname, 'fixtures/claude-session.jsonl');

describe('Library read index and view validation', () => {
  it('keeps matching messages in the original index space', async () => {
    const all = await read({ path: CLAUDE_FIXTURE, source: 'claude' }, { tokens: 100000 });
    const filtered = await read({ path: CLAUDE_FIXTURE, source: 'claude' }, { role: 'tool_use', tokens: 100000 });
    expect(filtered.messages.map((message) => message.index)).toEqual(
      all.messages.filter((message) => message.role === 'tool_use').map((message) => message.index),
    );
    expect(filtered.messages.length).toBeGreaterThan(0);
  });
});
