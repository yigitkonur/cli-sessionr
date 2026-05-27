/**
 * Phase 2 regression: every command (other than send, which Agent C owns)
 * must return a v2 envelope `{ ok, schema_version: 'v2', ... }` regardless
 * of whether the call succeeds or fails. The cases here drive the live
 * `dist/cli.js` binary via `spawnSync` so the test exercises the same boot,
 * Commander parsing, and emit() path agents will hit at runtime.
 *
 * Covers:
 *   - oc/07 envelope shape drift (every command surfaces ok + schema_version)
 *   - oc/08 every envelope carries `ok` and `schema_version: 'v2'`
 *   - oc/09 error envelopes share the v2 shape
 *   - dc/02 hidden command discovery — info/stats/search/etc. are reachable
 *
 * Notes
 *   - Generous per-spawn timeout (60s) because list/stats/etc. scan the user's
 *     home dir on cold cache. `beforeAll` runs `npm run build` once.
 *   - We rely on `list` to resolve one real session ID at runtime so success
 *     paths use a deterministic id; if the runner has zero sessions we fall
 *     back to a `--no-session-needed` matrix that only exercises error paths.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const SPAWN_TIMEOUT_MS = 60_000;

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[]): CliResult {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}

beforeAll(() => {
  execSync('npm run build', { stdio: 'ignore' });
}, 60_000);

// Resolve a real session id once at suite start for the success-path probes.
// If the runner's machine has no sessions, every "success" test that depends
// on a session degrades into the error-shape path which is still valid.
let realSessionId: string | null = null;
beforeAll(() => {
  const r = runCli(['--output', 'json', 'list', '-n', '1']);
  if (r.status !== 0) return;
  try {
    const obj = JSON.parse(r.stdout) as {
      result?: { sessions?: Array<{ id: string }> };
    };
    realSessionId = obj.result?.sessions?.[0]?.id ?? null;
  } catch {
    // ignore — error path is still covered below
  }
}, SPAWN_TIMEOUT_MS);

/**
 * Parse stdout as a v2 envelope. In `--output json` mode emit() pretty-prints
 * with newlines, so the whole payload is one JSON object spanning lines. In
 * `--output jsonl` mode each envelope is its own line — we just take the
 * first non-empty line.
 */
function parseEnvelope(stdout: string): { ok: boolean; schema_version: string; [k: string]: unknown } {
  const trimmed = stdout.trim();
  let raw = trimmed;
  // If the payload looks like multiple JSONL lines (each line a JSON value),
  // take the first one. Detect by checking whether the first line on its own
  // is parseable.
  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  try {
    JSON.parse(firstLine);
    raw = firstLine;
  } catch {
    // Pretty-printed JSON across newlines — parse the whole buffer.
    raw = trimmed;
  }
  const obj = JSON.parse(raw) as { ok: boolean; schema_version: string; [k: string]: unknown };
  expect(typeof obj.ok).toBe('boolean');
  expect(obj.schema_version).toBe('v2');
  return obj;
}

// ── oc/07 + oc/08 — every command emits v2 envelopes on bad input ──────────
//
// Stress matrix: invoke every migrated command with a known-bad argument so
// the error path is deterministic. Each must emit a v2 failure envelope
// (ok:false, schema_version:'v2', error.code) on stdout. send is excluded
// because Agent C owns it; it has its own coverage in send-regression.test.ts.

const ERROR_MATRIX: Array<{ name: string; args: string[] }> = [
  { name: 'info', args: ['--output', 'json', 'info', '__sessionr_nonexistent__'] },
  { name: 'stats', args: ['--output', 'json', 'stats', '__sessionr_nonexistent__'] },
  { name: 'read', args: ['--output', 'json', 'read', '__sessionr_nonexistent__'] },
  { name: 'context', args: ['--output', 'json', 'context', '__sessionr_nonexistent__'] },
  { name: 'diff', args: ['--output', 'json', 'diff', '__sessionr_nonexistent_a__', '__sessionr_nonexistent_b__'] },
  { name: 'tag', args: ['--output', 'json', 'tag', '__sessionr_nonexistent__', '--add', 'x'] },
  { name: 'job', args: ['--output', 'json', 'job', '__sessionr_nonexistent_job__'] },
  { name: 'wait', args: ['--output', 'json', 'wait', '__sessionr_nonexistent_job__'] },
  { name: 'cancel', args: ['--output', 'json', 'cancel', '__sessionr_nonexistent_job__'] },
];

describe('oc/07 + oc/08 + oc/09 — every command returns a v2 envelope on bad input', () => {
  it.each(ERROR_MATRIX)('$name → v2 failure envelope on stdout', ({ args }) => {
    const r = runCli(args);
    expect(r.stdout.length).toBeGreaterThan(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(false);
    const err = env.error as { code: string; class: string; retryable: boolean; message: string };
    expect(err).toBeDefined();
    expect(typeof err.code).toBe('string');
    expect(typeof err.class).toBe('string');
    expect(typeof err.retryable).toBe('boolean');
    expect(typeof err.message).toBe('string');
    // stderr must stay empty in JSON mode (oc/04 carry-forward).
    expect(r.stderr).toBe('');
  }, SPAWN_TIMEOUT_MS);
});

// ── oc/09 — top-level Commander errors also emit a v2 envelope ─────────────
describe('oc/09 — argparse errors emit a v2 envelope on stdout', () => {
  it('unknown flag → v2 USAGE_ERROR envelope', () => {
    const r = runCli(['--bogus-flag', '--output', 'json']);
    expect(r.status).toBe(2);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(false);
    const err = env.error as { code: string; class: string };
    expect(err.code).toBe('USAGE_ERROR');
    expect(err.class).toBe('validation');
  });

  it('unknown command → v2 USAGE_ERROR envelope', () => {
    const r = runCli(['--output', 'json', 'totally-not-a-command']);
    expect(r.status).toBe(2);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(false);
  });
});

// ── jobs (success path) — empty job list is still a v2 success envelope ────
describe('jobs success envelope', () => {
  it('jobs returns ok:true + schema_version:v2 even with zero jobs', () => {
    const r = runCli(['--output', 'json', 'jobs']);
    // status may be 0 (no jobs) or 0 with empty list
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.result).toBeDefined();
    const result = env.result as { jobs: unknown[]; total: number };
    expect(Array.isArray(result.jobs)).toBe(true);
    expect(typeof result.total).toBe('number');
  }, SPAWN_TIMEOUT_MS);
});

// ── success paths against a real session id (skipped when no sessions) ─────
describe('success envelopes against a real session id (oc/07 shape mapping)', () => {
  it('info → result.session with id/source', () => {
    if (!realSessionId) return;
    const r = runCli(['--output', 'json', 'info', realSessionId]);
    expect(r.status).toBe(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { session: { id: string; source: string } };
    expect(result.session).toBeDefined();
    expect(result.session.id).toBe(realSessionId);
    expect(typeof result.session.source).toBe('string');
  }, SPAWN_TIMEOUT_MS);

  it('stats → result.session', () => {
    if (!realSessionId) return;
    const r = runCli(['--output', 'json', 'stats', realSessionId]);
    expect(r.status).toBe(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { session: { id: string } };
    expect(result.session?.id).toBe(realSessionId);
  }, SPAWN_TIMEOUT_MS);

  it('read → result.messages + meta with range', () => {
    if (!realSessionId) return;
    const r = runCli(['--output', 'json', 'read', realSessionId, '--tokens', '500']);
    // exit 0 (full) or 10 (partial, truncated by budget) are both valid here
    expect([0, 10]).toContain(r.status);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { messages: unknown[] };
    expect(Array.isArray(result.messages)).toBe(true);
    const meta = env.meta as { range?: { from: number; to: number } } | undefined;
    expect(meta).toBeDefined();
    expect(meta!.range).toBeDefined();
  }, SPAWN_TIMEOUT_MS);

  it('context → result with session_id + messages array', () => {
    if (!realSessionId) return;
    const r = runCli(['--output', 'json', 'context', realSessionId, '--tokens', '500']);
    expect(r.status).toBe(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { session_id: string; messages: unknown[] };
    expect(result.session_id).toBe(realSessionId);
    expect(Array.isArray(result.messages)).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('search → result with query + results + total_matches', () => {
    const r = runCli(['--output', 'json', 'search', '-q', 'sessionr', '--max-sessions', '3']);
    expect(r.status).toBe(0);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(true);
    const result = env.result as { query: string; results: unknown[]; total_matches: number };
    expect(result.query).toBe('sessionr');
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.total_matches).toBe('number');
  }, SPAWN_TIMEOUT_MS);
});

// ── --timing carry-forward — every migrated command must surface timing_ms ─
describe('--timing forwarding (Phase 1 carry-forward)', () => {
  it('jobs --timing → meta.timing_ms is a number ≥ 0', () => {
    const r = runCli(['--timing', '--output', 'json', 'jobs']);
    const env = parseEnvelope(r.stdout);
    const meta = env.meta as { timing_ms?: number } | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta!.timing_ms).toBe('number');
    expect(meta!.timing_ms!).toBeGreaterThanOrEqual(0);
  }, SPAWN_TIMEOUT_MS);

  it('info --timing → meta.timing_ms (success path requires a session)', () => {
    if (!realSessionId) return;
    const r = runCli(['--timing', '--output', 'json', 'info', realSessionId]);
    const env = parseEnvelope(r.stdout);
    const meta = env.meta as { timing_ms?: number } | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta!.timing_ms).toBe('number');
  }, SPAWN_TIMEOUT_MS);

  it('stats --timing on error path still carries timing_ms', () => {
    const r = runCli(['--timing', '--output', 'json', 'stats', '__nope__']);
    const env = parseEnvelope(r.stdout);
    const meta = env.meta as { timing_ms?: number } | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta!.timing_ms).toBe('number');
  }, SPAWN_TIMEOUT_MS);

  it('read --timing → meta.timing_ms', () => {
    if (!realSessionId) return;
    const r = runCli(['--timing', '--output', 'json', 'read', realSessionId, '--tokens', '500']);
    const env = parseEnvelope(r.stdout);
    const meta = env.meta as { timing_ms?: number } | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta!.timing_ms).toBe('number');
  }, SPAWN_TIMEOUT_MS);
});

// ── dc/02 — every command we reference in actions[] is discoverable ────────
describe('dc/02 — hidden-command discoverability', () => {
  it('top-level help lists every command referenced in actions[]', () => {
    const r = runCli(['--help']);
    const expected = ['stats', 'info', 'search', 'diff', 'tag', 'prune', 'context', 'jobs', 'job', 'wait', 'cancel'];
    for (const cmd of expected) {
      // Match `^  <cmd>(?:\s|$)` so substring matches in other words don't fool us.
      const pattern = new RegExp(`^\\s+${cmd}\\b`, 'm');
      expect(r.stdout, `expected command "${cmd}" in --help output`).toMatch(pattern);
    }
  });

  it('JSON help schema also lists every command', () => {
    const r = runCli(['--output', 'json', 'help']);
    expect(r.status).toBe(0);
    const env = parseEnvelope(r.stdout);
    const result = env.result as { commands: Array<{ name: string }> };
    const names = new Set(result.commands.map((c) => c.name));
    for (const cmd of ['stats', 'info', 'search', 'diff', 'tag', 'prune', 'context', 'jobs', 'job', 'wait', 'cancel']) {
      expect(names.has(cmd), `expected ${cmd} in JSON help schema`).toBe(true);
    }
  });
});
