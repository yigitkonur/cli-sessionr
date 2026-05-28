/**
 * Live local-session sampler.
 *
 * Unlike the synthetic-fixture suites, this exercises the v2 envelope contract
 * against the developer's REAL on-disk sessions (~/.claude, ~/.codex, etc.).
 * It picks a random recent session per available source and runs the full
 * read/info/stats/etag contract on it — catching real-world parser drift that
 * fixtures miss (a model field the parser didn't expect, a tool block shape, a
 * date format, an empty session, etc.).
 *
 * GATED: only runs when SR_LIVE=1. Skipped in CI and in normal `npm test` so it
 * never depends on machine-specific data. Run it explicitly:
 *
 *   SR_LIVE=1 npm test -- live-local
 *
 * Why random selection: a fixed session ID rots (gets pruned, gets archived).
 * Sampling from "most recent N" keeps the test meaningful over time and
 * surfaces parser regressions on whatever the developer actually ran lately.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LIVE = process.env.SR_LIVE === '1';
const CLI = join(process.cwd(), 'dist', 'cli.js');

// The sources we'll sample if they have data on this machine.
const SOURCES = ['claude', 'codex', 'gemini', 'copilot'] as const;

function runJson(args: string[]): { obj: Record<string, unknown>; status: number | null; stderr: string } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    obj = { __parse_error: true, __stdout: r.stdout.slice(0, 500) };
  }
  return { obj, status: r.status, stderr: r.stderr };
}

/** Most-recent session ids for a source (cwd:all so we see everything). Empty if none. */
function recentIds(source: string, n = 10): string[] {
  const { obj } = runJson(['--output', 'json', 'list', source, '-n', String(n), '--cwd', 'all']);
  const sessions = (obj.result as { sessions?: Array<{ id: string; isEmpty?: boolean }> } | undefined)?.sessions ?? [];
  return sessions.filter((s) => !s.isEmpty).map((s) => s.id);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

describe.skipIf(!LIVE)('live local-session sampler (SR_LIVE=1)', () => {
  beforeAll(() => {
    execSync('npm run build', { stdio: 'ignore' });
  }, 60_000);

  for (const source of SOURCES) {
    describe(`source: ${source}`, () => {
      let id: string | undefined;

      beforeAll(() => {
        const ids = recentIds(source, 10);
        id = ids.length > 0 ? pickRandom(ids) : undefined;
      }, 60_000);

      it('read returns a v2 envelope with messages + a well-formed etag', () => {
        if (!id) return; // no data for this source on this machine — skip silently
        const { obj, status } = runJson(['--output', 'json', 'read', id, '--tokens', '2000', '--preset', 'verbose']);
        // exit 0 (full) or 10 (partial/truncated) are both valid successes
        expect([0, 10]).toContain(status);
        expect(obj.ok).toBe(true);
        expect(obj.schema_version).toBe('v2');
        const result = obj.result as { messages: unknown[] };
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBeGreaterThan(0);
        const meta = obj.meta as { etag?: string };
        expect(meta.etag).toMatch(/^[a-f0-9]{16}$/);
      });

      it('read messages have no dual content+blocks waste (verbose → blocks only)', () => {
        if (!id) return;
        const { obj } = runJson(['--output', 'json', 'read', id, '--tokens', '2000', '--preset', 'verbose']);
        const messages = (obj.result as { messages: Array<Record<string, unknown>> }).messages;
        for (const m of messages) {
          // A message must never carry BOTH content and blocks (oc/12 dedup).
          const hasContent = Object.prototype.hasOwnProperty.call(m, 'content');
          const hasBlocks = Object.prototype.hasOwnProperty.call(m, 'blocks');
          expect(hasContent && hasBlocks, `msg index ${String(m.index)} carries both content and blocks`).toBe(false);
        }
      });

      it('every envelope key is snake_case (no camelCase leak on real data)', () => {
        if (!id) return;
        const { obj } = runJson(['--output', 'json', 'stats', id]);
        const offenders: string[] = [];
        const walk = (v: unknown, path: string[]): void => {
          if (!v || typeof v !== 'object') return;
          if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, `[${i}]`])); return; }
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            // Skip the tool_use `input` subtree — those are arbitrary user-tool
            // arguments and are intentionally preserved verbatim.
            if (k === 'input') continue;
            if (/[a-z][A-Z]/.test(k)) offenders.push([...path, k].join('.'));
            walk(val, [...path, k]);
          }
        };
        walk(obj, []);
        expect(offenders, `camelCase keys leaked: ${offenders.join(', ')}`).toEqual([]);
      });

      it('etag round-trips: re-reading with the same etag short-circuits (exit 42) IF the session is stable', () => {
        if (!id) return;
        const first = runJson(['--output', 'json', 'read', id, '--tokens', '2000', '--preset', 'verbose']);
        const etag = (first.obj.meta as { etag?: string }).etag;
        if (!etag) return;
        const second = spawnSync('node', [CLI, '--output', 'json', 'read', id, '--if-changed', etag, '--tokens', '2000', '--preset', 'verbose'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        // If the session file was appended to between the two reads (active
        // session), the etag legitimately changes and we get a fresh read.
        // Both outcomes are correct; we only assert the contract holds.
        if (second.status === 42) {
          const body = JSON.parse(second.stdout) as { result?: { unchanged?: boolean } };
          expect(body.result?.unchanged).toBe(true);
        } else {
          expect([0, 10]).toContain(second.status);
        }
      });

      it('info is a cheap v2 envelope with snake_case by_role', () => {
        if (!id) return;
        const { obj, status } = runJson(['--output', 'json', 'info', id]);
        expect(status).toBe(0);
        expect(obj.ok).toBe(true);
        const byRole = (obj.result as { session: { by_role: Record<string, number> } }).session.by_role;
        // snake_case enum keys, never toolUse/toolResult
        expect(byRole).not.toHaveProperty('toolUse');
        expect(byRole).not.toHaveProperty('toolResult');
      });
    });
  }
});
