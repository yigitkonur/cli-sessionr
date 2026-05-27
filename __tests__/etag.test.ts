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

  // it/03 regression: two reads against the same session-state but with
  // different --preset values MUST produce different etags. Otherwise an
  // agent polling with `--preset full --if-changed <preset=minimal-etag>`
  // would 304-short-circuit even though the *view* it asked for has
  // never been rendered.
  it('preset and tokenBudget alone produce distinct etags', () => {
    const minimal = computeETag(session, { preset: 'minimal', tokenBudget: 2000, from: 1, to: 10 });
    const verbose = computeETag(session, { preset: 'verbose', tokenBudget: 2000, from: 1, to: 10 });
    const full = computeETag(session, { preset: 'full', tokenBudget: 2000, from: 1, to: 10 });
    expect(minimal).not.toBe(verbose);
    expect(verbose).not.toBe(full);
    expect(minimal).not.toBe(full);

    const small = computeETag(session, { preset: 'verbose', tokenBudget: 1000, from: 1, to: 10 });
    const large = computeETag(session, { preset: 'verbose', tokenBudget: 8000, from: 1, to: 10 });
    expect(small).not.toBe(large);
  });

  // Sanity: the etag is the documented 16-hex-char hash so downstream
  // poll-loops can validate the shape without round-tripping.
  it('returns a 16-character lowercase hex string', () => {
    const etag = computeETag(session, { preset: 'verbose', tokenBudget: 4000, from: 1, to: 5 });
    expect(etag).toMatch(/^[0-9a-f]{16}$/);
  });
});
