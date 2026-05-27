/**
 * Regression: every v2 envelope must use snake_case keys + snake_case enum
 * values. Internal TS types use camelCase by convention; the rename layer
 * lives in src/output/serialize.ts (toExternal / toExternalSession). If a
 * new field gets added without going through that layer, agents reading
 * `result.session.by_role.tool_use` get `undefined` and downstream pipelines
 * silently break.
 *
 * Caught in Phase 2 code review: info/stats originally leaked byRole.toolUse
 * (camelCase keys + camelCase values) through `success({session: ...})` — fix
 * normalizes via toExternal(...) / toExternalSession(...).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function runJson(args: string[]): Record<string, unknown> {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

let SESSION_ID: string;

beforeAll(() => {
  execSync('npm run build', { stdio: 'ignore' });
  const list = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '10']);
  const sessions = (list.result as { sessions: Array<{ id: string }> }).sessions;
  if (sessions.length === 0) {
    throw new Error('No local sessions available for snake_case regression test');
  }
  // Pick the third-most-recent — the most recent few might be actively
  // written, which we don't care about here (we only test field names).
  SESSION_ID = sessions[Math.min(2, sessions.length - 1)].id;
}, 60_000);

// Helpers ─────────────────────────────────────────────────────────────────

function isCamelCase(key: string): boolean {
  // A key with at least one lowercase-uppercase boundary, e.g. "toolUse".
  return /[a-z][A-Z]/.test(key);
}

function collectCamelCaseKeys(value: unknown, path: string[] = []): string[] {
  const offenders: string[] = [];
  if (!value || typeof value !== 'object') return offenders;
  if (Array.isArray(value)) {
    value.forEach((v, i) => offenders.push(...collectCamelCaseKeys(v, [...path, `[${i}]`])));
    return offenders;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isCamelCase(k)) offenders.push([...path, k].join('.'));
    offenders.push(...collectCamelCaseKeys(v, [...path, k]));
  }
  return offenders;
}

// Tests ───────────────────────────────────────────────────────────────────

describe('v2 envelope keys are snake_case', () => {
  it('info: no camelCase keys leak through', () => {
    const env = runJson(['--output', 'json', 'info', SESSION_ID]);
    expect(collectCamelCaseKeys(env)).toEqual([]);
  });

  it('info: by_role uses tool_use / tool_result (not toolUse / toolResult)', () => {
    const env = runJson(['--output', 'json', 'info', SESSION_ID]);
    const byRole = ((env.result as { session: { by_role: Record<string, unknown> } }).session.by_role);
    expect(byRole).toHaveProperty('tool_use');
    expect(byRole).toHaveProperty('tool_result');
    expect(byRole).not.toHaveProperty('toolUse');
    expect(byRole).not.toHaveProperty('toolResult');
  });

  it('stats: no camelCase keys leak through (full session payload)', () => {
    const env = runJson(['--output', 'json', 'stats', SESSION_ID]);
    expect(collectCamelCaseKeys(env)).toEqual([]);
  });

  it('stats: token_usage uses cache_read / cache_creation (not cacheRead / cacheCreation) when present', () => {
    const env = runJson(['--output', 'json', 'stats', SESSION_ID]);
    const usage = ((env.result as { session: { token_usage?: Record<string, unknown> } }).session.token_usage) ?? {};
    // We only assert the keys when the underlying session HAS cache info; many
    // sessions don't have cache reads. The point is: if present, they're snake.
    if ('cacheRead' in usage) throw new Error('cacheRead leaked — should be cache_read');
    if ('cacheCreation' in usage) throw new Error('cacheCreation leaked — should be cache_creation');
  });

  it('stats: by_block_type uses tool_use / tool_result (not toolUse / toolResult)', () => {
    const env = runJson(['--output', 'json', 'stats', SESSION_ID]);
    const byBlock = ((env.result as { session: { stats: { by_block_type?: Record<string, unknown> } } }).session.stats?.by_block_type) ?? {};
    if ('toolUse' in byBlock) throw new Error('byBlockType.toolUse leaked');
    if ('toolResult' in byBlock) throw new Error('byBlockType.toolResult leaked');
  });

  it('read: meta + result keys are all snake_case', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '500']);
    expect(collectCamelCaseKeys(env)).toEqual([]);
  });
});
