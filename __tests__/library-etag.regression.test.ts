import { it, expect } from 'vitest';
import * as path from 'node:path';
import { parseClaudeSession, read, registerSource } from '../src/index.js';
import type { NormalizedMessage } from '../src/types.js';

it('does not reuse an ETag across distinct role-filtered views', async () => {
  const file = path.resolve(__dirname, 'fixtures/claude-session.jsonl');
  const session = await parseClaudeSession(file);
  const roles: NormalizedMessage['role'][] = ['assistant', 'user', 'assistant', 'tool_result', 'system', 'user'];
  session.messages = roles.map((role, index) => ({
    index: index + 1, role, content: `synthetic-${index}`,
    blocks: [{ type: 'text', text: `synthetic-${index}` }], timestamp: session.metadata.createdAt,
  }));
  session.stats.totalMessages = session.messages.length;
  registerSource({ name: 'view-key-probe', label: 'View key', color: 'blue', find: async () => [], parse: async () => session });
  const ref = { path: file, source: 'view-key-probe' };
  const first = await read(ref, { role: 'assistant,user', tokens: 4000 });
  const second = await read(ref, { role: 'assistant,tool_result', tokens: 4000 });
  expect(first.meta.range).toEqual(second.meta.range);
  expect(first.messages.map((message) => message.index)).not.toEqual(second.messages.map((message) => message.index));
  expect(first.meta.etag).not.toBe(second.meta.etag);
  const conditional = await read(ref, { role: 'assistant,tool_result', tokens: 4000, ifChanged: first.meta.etag });
  expect(conditional.meta.unchanged).not.toBe(true);
  expect(conditional.messages.map((message) => message.index)).toEqual(second.messages.map((message) => message.index));
  const reordered = await read(ref, { role: 'tool_result,assistant,assistant', tokens: 4000 });
  expect(reordered.meta.etag).toBe(second.meta.etag);
});
