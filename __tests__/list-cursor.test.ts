/**
 * it/05 unit-style coverage: the v2 `list` envelope must expose the cursor
 * as { command, offset, limit } so agents can both copy/paste AND compute
 * their own pagination math. The Phase 2 envelope migration accidentally
 * collapsed these to bare command strings.
 */
import { describe as vitestDescribe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function runJson(args: string[]): Record<string, unknown> {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  if (!r.stdout) throw new Error(`No stdout. stderr=${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

// Cursor next/prev/offset only exist with enough sessions to paginate (the
// offset test needs ≥6). On CI (empty home) there are none → skip the file.
execSync('npm run build', { stdio: 'ignore' });
const ENOUGH_SESSIONS: boolean = (() => {
  try {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '2']);
    return ((env.result as { total_available?: number } | undefined)?.total_available ?? 0) >= 6;
  } catch {
    return false;
  }
})();
const describe = ENOUGH_SESSIONS ? vitestDescribe : vitestDescribe.skip;

describe('list cursor shape', () => {
  // Long timeouts: --cwd all scans every session directory; on a developer
  // box that's thousands of files. We're testing the cursor SHAPE, but the
  // disk walk dominates wall-clock time.
  it('next has command + numeric offset + numeric limit', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '2']);
    expect(env.ok).toBe(true);
    const cursor = (env.result as { cursor: { next: unknown } }).cursor;
    const next = cursor.next as { command: string; offset: number; limit: number } | null;
    expect(next).toBeTruthy();
    expect(typeof next!.command).toBe('string');
    expect(next!.command).toContain('--offset');
    expect(typeof next!.offset).toBe('number');
    expect(next!.offset).toBe(2);
    expect(next!.limit).toBe(2);
  }, 120_000);

  it('first/prev are null on the first page', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '2']);
    const cursor = (env.result as { cursor: { first: unknown; prev: unknown } }).cursor;
    expect(cursor.first).toBeNull();
    expect(cursor.prev).toBeNull();
  }, 120_000);

  it('first/prev expose numeric offsets when on a non-first page', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '2', '--offset', '4']);
    const cursor = (env.result as { cursor: { first: unknown; prev: unknown } }).cursor;
    const first = cursor.first as { command: string; offset: number; limit: number } | null;
    const prev = cursor.prev as { command: string; offset: number; limit: number } | null;
    expect(first).toBeTruthy();
    expect(first!.offset).toBe(0);
    expect(prev).toBeTruthy();
    expect(prev!.offset).toBe(2);
  }, 120_000);
});
