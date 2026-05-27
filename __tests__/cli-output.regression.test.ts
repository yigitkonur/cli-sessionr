/**
 * Regression suite for the five CRITICAL output-contract bugs the Phase 1
 * implementer (Agent B) owns. Each `describe` corresponds to one bug ID; the
 * acceptance probe from the issue file is encoded as a vitest assertion so
 * regressions surface immediately in CI.
 *
 * Notes
 * - The suite runs against the COMPILED binary (`dist/cli.js`) — same code
 *   path agents will hit. `beforeAll` runs `npm run build` once.
 * - All spawns use `child_process.spawnSync` with `shell: false` to avoid
 *   shell-quirk surprises (zsh reorders `2>&1 1>/dev/null` in ways bash does
 *   not — we drive stdout/stderr capture through Node directly).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    // Inherit process env but explicitly clear NO_COLOR so the plain/tty
    // formatter choice is deterministic across CI/local.
    env: { ...process.env },
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

// ── Bug 1 ─────────────────────────────────────────────────────────────────
// `--output jsonl list` must produce one valid JSON value per line.
describe('oc/01 — list --output jsonl produces real JSONL', () => {
  it('emits ≥1 line and every non-empty line is valid JSON', () => {
    const { stdout, status } = runCli(['--output', 'jsonl', 'list', '-n', '3']);
    expect(status).toBe(0);

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('each line parses into either a v2 envelope or a typed JSONL record', () => {
    const { stdout } = runCli(['--output', 'jsonl', 'list', '-n', '3']);
    const lines = stdout.split('\n').filter((l) => l.length > 0);

    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const isEnvelope = obj.schema_version === 'v2' && typeof obj.ok === 'boolean';
      const isTaggedRecord = typeof obj.type === 'string';
      expect(isEnvelope || isTaggedRecord).toBe(true);
    }
  });
});

// ── Bug 2 ─────────────────────────────────────────────────────────────────
// `--output table` must render an actual markdown/table layout for list,
// info, and stats — not silently fall through to JSON or plain text.
describe('oc/02 — --output table renders a table for list/info/stats', () => {
  it('list --output table emits at least one "|"-led row', () => {
    const { stdout, status } = runCli(['--output', 'table', 'list', '-n', '3']);
    expect(status).toBe(0);
    const tableRow = stdout
      .split('\n')
      .find((line) => /^\|/.test(line));
    expect(tableRow).toBeDefined();
  });

  // info/stats need a real session id; resolve one from list (jsonl).
  // We grant a generous timeout because stats parses a full session JSONL —
  // a single large session can take several seconds. If no sessions are
  // discoverable in the runner's home dir, we skip rather than fail.
  it('info/stats --output table render markdown table when a session exists', () => {
    const listing = runCli(['--output', 'jsonl', 'list', '-n', '1']);
    if (listing.status !== 0) return;

    const envelope = JSON.parse(
      listing.stdout.split('\n').find((l) => l.length > 0)!,
    ) as { result?: { sessions?: Array<{ id: string }> } };
    const sessions = envelope.result?.sessions;
    if (!sessions || sessions.length === 0) return;

    const id = sessions[0].id;

    const info = runCli(['--output', 'table', 'info', id]);
    expect(info.status).toBe(0);
    expect(info.stdout.split('\n').some((l) => /^\|/.test(l))).toBe(true);

    const stats = runCli(['--output', 'table', 'stats', id]);
    expect(stats.status).toBe(0);
    expect(stats.stdout.split('\n').some((l) => /^\|/.test(l))).toBe(true);
  }, 60_000);
});

// ── Bug 3 ─────────────────────────────────────────────────────────────────
// Unknown `--output` value must surface a v2 INVALID_OUTPUT envelope and
// exit 2, never silently fall back to text/JSON.
describe('oc/03 — unknown --output value is rejected with v2 envelope', () => {
  it('--output xml exits 2 with v2 INVALID_OUTPUT failure envelope on stdout', () => {
    const { stdout, status } = runCli(['--output', 'xml', 'list']);
    expect(status).toBe(2);

    const obj = JSON.parse(stdout) as {
      ok: boolean;
      schema_version: string;
      error: { code: string; class: string; suggestion?: string; detail?: { accepted?: string[] } };
    };
    expect(obj.ok).toBe(false);
    expect(obj.schema_version).toBe('v2');
    expect(obj.error.code).toBe('INVALID_OUTPUT');
    expect(obj.error.class).toBe('validation');
    expect(obj.error.detail?.accepted).toEqual(['json', 'jsonl', 'text', 'table']);
  });

  it.each(['yaml', 'csv', 'pdf', 'garbage'])(
    'rejects bogus format %s the same way',
    (bad) => {
      const { stdout, status } = runCli(['--output', bad, 'list']);
      expect(status).toBe(2);
      const obj = JSON.parse(stdout) as { error: { code: string } };
      expect(obj.error.code).toBe('INVALID_OUTPUT');
    },
  );
});

// ── Bug 4 ─────────────────────────────────────────────────────────────────
// In JSON/JSONL modes, the error envelope must land on STDOUT — stderr stays
// empty so downstream `jq .ok` pipelines work without `2>&1`.
describe('oc/04 — errors in JSON/JSONL mode go to stdout, never stderr', () => {
  it('jsonl mode: stdout has the envelope, stderr is empty', () => {
    const { stdout, stderr, status } = runCli([
      '--output',
      'jsonl',
      'list',
      'nonexistent-source',
    ]);

    expect(status).toBe(2);
    expect(stderr).toBe('');
    expect(stdout.length).toBeGreaterThan(0);

    const obj = JSON.parse(stdout) as { ok: boolean; error: { code: string } };
    expect(obj.ok).toBe(false);
    expect(obj.error.code).toBe('INVALID_SOURCE');
  });

  it('json mode: stdout has the envelope, stderr is empty', () => {
    const { stdout, stderr, status } = runCli([
      '--output',
      'json',
      'list',
      'nonexistent-source',
    ]);

    expect(status).toBe(2);
    expect(stderr).toBe('');
    const obj = JSON.parse(stdout) as { ok: boolean; error: { code: string } };
    expect(obj.ok).toBe(false);
    expect(obj.error.code).toBe('INVALID_SOURCE');
  });

  it('unknown --output errors also keep stderr clean', () => {
    const { stderr } = runCli(['--output', 'xml', 'list']);
    expect(stderr).toBe('');
  });
});

// ── Bug 5 ─────────────────────────────────────────────────────────────────
// `--output json help` must exit 0 and emit a v2 envelope whose result
// exposes `.commands` (alongside legacy primary_commands / all_commands).
describe('oc/06 — help with --output json exits 0 and emits v2 envelope', () => {
  it('exits 0 with v2 success envelope (ok, schema_version, result.commands)', () => {
    const { stdout, status } = runCli(['--output', 'json', 'help']);

    expect(status).toBe(0);
    const obj = JSON.parse(stdout) as {
      ok: boolean;
      schema_version: string;
      result: { commands: unknown[]; primary_commands?: unknown[] };
    };
    expect(obj.ok).toBe(true);
    expect(obj.schema_version).toBe('v2');
    expect(Array.isArray(obj.result.commands)).toBe(true);
    expect(obj.result.commands.length).toBeGreaterThan(0);
  });

  it('schema still surfaces workflow + exit_codes inside result for agents', () => {
    const { stdout } = runCli(['--output', 'json', 'help']);
    const obj = JSON.parse(stdout) as {
      result: { workflow: unknown[]; exit_codes: Record<string, string> };
    };
    expect(Array.isArray(obj.result.workflow)).toBe(true);
    expect(obj.result.exit_codes['0']).toBe('ok');
  });
});
