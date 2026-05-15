import { describe, expect, it } from 'vitest';
import { computeETag } from '../src/etag.js';
import type { NormalizedSession } from '../src/types.js';

const session: NormalizedSession = {
  id: 'test-session',
  source: 'codex',
  filePath: '/tmp/session.jsonl',
  metadata: {
    cwd: '/tmp',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:01:00.000Z'),
    fileBytes: 100,
    rawLineCount: 5,
  },
  messages: [],
  stats: {
    totalMessages: 10,
    byRole: { user: 1, assistant: 1, system: 0, toolUse: 0, toolResult: 0 },
    byBlockType: {},
    toolFrequency: [],
    filesModified: [],
  },
};

describe('computeETag', () => {
  it('changes when read rendering options change', () => {
    const base = computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'head',
      format: 'json',
    });

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 8000,
      from: 1,
      to: 10,
      anchor: 'head',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'minimal',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'head',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'tail',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 2,
      to: 10,
      anchor: 'head',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 9,
      anchor: 'head',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'search',
      search: 'deploy',
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'page',
      page: 2,
      format: 'json',
    })).not.toBe(base);

    expect(computeETag(session, {
      preset: 'verbose',
      tokenBudget: 2000,
      from: 1,
      to: 10,
      anchor: 'head',
      format: 'jsonl',
    })).not.toBe(base);
  });
});
