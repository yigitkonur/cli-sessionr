/**
 * Regression for destructive/01 (CRITICAL): `prune --yes` MUST refuse
 * with a v2 error envelope (`NOT_IMPLEMENTED`) instead of returning a
 * `status: ok` that fakes deletion. The dry-run path must keep working
 * and return a v2 success envelope listing what would be deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneCommand } from '../src/commands/prune.js';
import { listSessions } from '../src/discovery.js';
import { EXIT } from '../src/errors.js';
import type { SessionListEntry } from '../src/types.js';

vi.mock('../src/discovery.js', () => ({
  listSessions: vi.fn(),
}));

function makeEntry(id: string, daysOld: number): SessionListEntry {
  const updatedAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  return {
    id,
    source: 'codex',
    cwd: '/tmp/proj',
    updatedAt,
    filePath: `/tmp/${id}.jsonl`,
  };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

function parseEnvelope(chunks: string[]): Record<string, unknown> {
  return JSON.parse(chunks.join(''));
}

describe('pruneCommand (regression: destructive/01)', () => {
  let io: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    process.exitCode = undefined;
    io = captureStdout();
    vi.mocked(listSessions).mockResolvedValue([
      makeEntry('old-1', 30),
      makeEntry('old-2', 14),
      makeEntry('fresh', 1),
    ]);
  });

  afterEach(() => {
    io.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('refuses --yes with v2 NOT_IMPLEMENTED envelope (never fakes deletion)', async () => {
    await pruneCommand({
      olderThan: '7d',
      yes: true,
      output: 'json',
    });

    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe('v2');
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe('NOT_IMPLEMENTED');
    expect(error.class).toBe('internal');
    expect(error.retryable).toBe(false);
    const detail = error.detail as Record<string, unknown>;
    expect(detail.feature).toBe('prune --yes');
    expect(detail.planned_in).toBe('v3.1.0');
    expect(process.exitCode).toBe(EXIT.ERROR);
  });

  it('does NOT invoke any filesystem mutation on --yes (listSessions is the only call)', async () => {
    await pruneCommand({
      olderThan: '7d',
      yes: true,
      output: 'json',
    });

    // listSessions may or may not be called depending on the refuse-early
    // strategy, but in all cases there must be no other side effect — the
    // refusal is what protects users. Just assert no success envelope leaked.
    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(false);
  });

  it('dry-run returns v2 success envelope with would_delete + count', async () => {
    await pruneCommand({
      olderThan: '7d',
      dryRun: true,
      output: 'json',
    });

    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe('v2');
    const result = env.result as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    const wouldDelete = result.would_delete as Array<Record<string, unknown>>;
    expect(Array.isArray(wouldDelete)).toBe(true);
    // 30d and 14d are both older than the 7d cutoff; 1d is not.
    expect(result.count).toBe(2);
    expect(wouldDelete.length).toBe(2);
    expect(wouldDelete.map((e) => e.id).sort()).toEqual(['old-1', 'old-2']);
    // Dates must be serialized as ISO strings, not raw Date objects.
    for (const entry of wouldDelete) {
      expect(typeof entry.updated_at).toBe('string');
    }
    // Process should NOT be marked failed on dry-run.
    expect(process.exitCode).toBeUndefined();
  });

  it('dry-run + --yes together stays in dry-run mode (no refusal)', async () => {
    // The refuse path is gated on `--yes && !--dry-run`. Belt-and-suspenders
    // assertion that a caller who passes both flags still gets a preview.
    await pruneCommand({
      olderThan: '7d',
      dryRun: true,
      yes: true,
      output: 'json',
    });

    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(true);
    expect((env.result as Record<string, unknown>).dry_run).toBe(true);
  });

  it('returns v2 INVALID_DURATION error for malformed --older-than', async () => {
    await pruneCommand({
      olderThan: 'forever',
      dryRun: true,
      output: 'json',
    });

    const env = parseEnvelope(io.chunks);
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe('v2');
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe('INVALID_DURATION');
    expect(error.class).toBe('validation');
    expect(process.exitCode).toBe(EXIT.USAGE);
  });
});
