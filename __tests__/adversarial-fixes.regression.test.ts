/**
 * Regression coverage for the 8 findings from the v3 Codex adversarial review.
 * Each had ZERO prior test coverage — that's why they survived 367 tests.
 *
 *   H1  read no-args → v2 envelope (was plain text on stderr)
 *   H2  read --batch --role <invalid> → INVALID_ROLE (was silent ok:true empty)
 *   H3  list/search result entries are snake_case (were camelCase leaks)
 *   M4  help --output json result has no api_version
 *   M5  read --batch mixed-result stream is valid JSONL throughout
 *   M6  search numeric flags reject out-of-range (were silently clamped)
 *   M7  computeETag is content-sensitive (was metadata-only → false-stable)
 *
 * CLI tests spawn the built binary; session-dependent ones skip cleanly when
 * the machine has no local sessions (CI).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeETag } from '../src/etag.js';
import type { NormalizedSession } from '../src/types.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}
function runJson(args: string[]): { obj: Record<string, unknown>; status: number | null } {
  const { stdout, status } = run(args);
  return { obj: JSON.parse(stdout) as Record<string, unknown>, status };
}
function firstSessionId(): string | undefined {
  const { obj } = runJson(['--output', 'json', 'list', '-n', '5', '--cwd', 'all']);
  const sessions = (obj.result as { sessions?: Array<{ id: string }> } | undefined)?.sessions ?? [];
  return sessions[0]?.id;
}
function hasCamelCaseKey(o: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string[]): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, `[${i}]`])); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'input') continue; // tool_use args are verbatim by contract
      if (/[a-z][A-Z]/.test(k)) out.push([...path, k].join('.'));
      walk(val, [...path, k]);
    }
  };
  walk(o, []);
  return out;
}

beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); }, 60_000);

// ── H1 ──────────────────────────────────────────────────────────────────────
describe('H1 — read with no args emits a v2 envelope, not plain stderr', () => {
  it('ok:false MISSING_ARGUMENT on stdout, stderr empty, exit 2', () => {
    const { stdout, stderr, status } = run(['--output', 'json', 'read']);
    expect(status).toBe(2);
    expect(stderr).toBe('');
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe('v2');
    expect(env.error.code).toBe('MISSING_ARGUMENT');
    expect(env.error.class).toBe('validation');
  });
});

// ── M4 ──────────────────────────────────────────────────────────────────────
describe('M4 — help --output json result has no api_version', () => {
  it('result omits the retired api_version field', () => {
    const { obj, status } = runJson(['--output', 'json', 'help']);
    expect(status).toBe(0);
    expect(obj.ok).toBe(true);
    expect(obj.result as Record<string, unknown>).not.toHaveProperty('api_version');
    // version (the CLI version) is still present
    expect((obj.result as { version?: string }).version).toBeTruthy();
  });
});

// ── M6 ──────────────────────────────────────────────────────────────────────
describe('M6 — search numeric flags reject out-of-range instead of clamping', () => {
  it('--top 0 → INVALID_RANGE exit 2', () => {
    const { obj, status } = runJson(['--output', 'json', 'search', '-q', 'x', '--top', '0', '--max-sessions', '3']);
    expect(status).toBe(2);
    expect(obj.ok).toBe(false);
    expect((obj.error as { code: string }).code).toBe('INVALID_RANGE');
  });
  it('--max-sessions nope → INVALID_RANGE exit 2', () => {
    const { obj, status } = runJson(['--output', 'json', 'search', '-q', 'x', '--max-sessions', 'nope']);
    expect(status).toBe(2);
    expect((obj.error as { code: string }).code).toBe('INVALID_RANGE');
  });
});

// ── H3 ──────────────────────────────────────────────────────────────────────
describe('H3 — list/search result entries are snake_case', () => {
  it('list result.sessions has no camelCase keys', () => {
    const id = firstSessionId();
    if (!id) return; // no local sessions — skip
    const { obj } = runJson(['--output', 'json', 'list', '-n', '5', '--cwd', 'all']);
    expect(hasCamelCaseKey(obj.result)).toEqual([]);
  });
  it('search result.results has no camelCase keys', () => {
    const id = firstSessionId();
    if (!id) return;
    // search builds a full session index before slicing, so on a machine with
    // thousands of real sessions a cold scan can run long — give it headroom.
    const { obj } = runJson(['--output', 'json', 'search', '-q', 'the', '--top', '1', '--max-sessions', '10']);
    expect(hasCamelCaseKey(obj.result)).toEqual([]);
  }, 120_000);
});

// ── H2 + M5 ───────────────────────────────────────────────────────────────
describe('H2/M5 — batch role validation + uniform JSONL framing', () => {
  it('H2: --batch --role <invalid> → INVALID_ROLE exit 2 (not silent empty)', () => {
    const id = firstSessionId();
    if (!id) return;
    const f = join(tmpdir(), `sr-batch-${Date.now()}.txt`);
    writeFileSync(f, `${id}\n`);
    const { stdout, status } = run(['--output', 'json', 'read', '--batch', f, '--role', 'madeup']);
    expect(status).toBe(2);
    const env = JSON.parse(stdout.trim().split('\n')[0]);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_ROLE');
  });
  it('M5: a missing id mid-batch keeps every line valid single-line JSONL', () => {
    const id = firstSessionId();
    if (!id) return;
    const f = join(tmpdir(), `sr-batch-mixed-${Date.now()}.txt`);
    writeFileSync(f, `${id}\n__definitely_missing__\n`);
    const { stdout, status } = run(['--output', 'json', 'read', '--batch', f, '--tokens', '200']);
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + session + error
    const kinds = lines.map((l) => {
      const o = JSON.parse(l) as { ok?: boolean; result?: { batch_header?: boolean }; error?: { code: string } };
      if (o.result?.batch_header) return 'header';
      return o.ok ? 'session' : `error:${o.error?.code}`;
    });
    expect(kinds[0]).toBe('header');
    expect(kinds).toContain('error:SESSION_NOT_FOUND');
    expect(status).not.toBe(0); // a failed session surfaces a non-zero exit
  });
});

// ── M7 (unit) ────────────────────────────────────────────────────────────────
describe('M7 — computeETag is content-sensitive', () => {
  const baseSession = (content: string): NormalizedSession => ({
    id: 's1', source: 'claude', filePath: '/tmp/s1.jsonl',
    metadata: {
      cwd: '/tmp', createdAt: new Date('2026-05-27T00:00:00Z'),
      updatedAt: new Date('2026-05-27T00:00:00Z'), // IDENTICAL metadata
      fileBytes: 100, rawLineCount: 2,
    },
    messages: [
      { index: 1, role: 'user', timestamp: new Date('2026-05-27T00:00:00Z'), content, blocks: [{ type: 'text', text: content }] },
    ],
    stats: {
      totalMessages: 1, // IDENTICAL count
      byRole: { user: 1, assistant: 0, system: 0, toolUse: 0, toolResult: 0 },
      byBlockType: { text: 1 }, toolFrequency: [], filesModified: [],
    },
  });

  it('different message content with identical metadata → different etag', () => {
    const a = computeETag(baseSession('hello world'), { preset: 'standard', tokenBudget: 4000 });
    const b = computeETag(baseSession('totally different body'), { preset: 'standard', tokenBudget: 4000 });
    expect(a).not.toBe(b);
  });

  it('identical content + metadata + view → stable etag (so --if-changed can match)', () => {
    const a = computeETag(baseSession('same'), { preset: 'standard', tokenBudget: 4000 });
    const b = computeETag(baseSession('same'), { preset: 'standard', tokenBudget: 4000 });
    expect(a).toBe(b);
  });

  it('different preset still yields a different etag (view-aware, preserved)', () => {
    const a = computeETag(baseSession('x'), { preset: 'minimal', tokenBudget: 4000 });
    const b = computeETag(baseSession('x'), { preset: 'verbose', tokenBudget: 4000 });
    expect(a).not.toBe(b);
  });
});
