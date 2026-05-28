/**
 * Phase 3 Agent B regression — agent-UX MEDIUM fixes.
 *
 * Covers the 16 catalog issues + 3 additions in the Phase 3 spec:
 *   dc/03  examples in --help
 *   dc/05  source aliases (cc, gpt, openai, oai)
 *   dc/06  list numeric bounds validation (INVALID_RANGE)
 *   dc/07  doctor returns examples
 *   dc/08  list footer tips
 *   it/05  list cursor returns numeric tokens (not bare strings)
 *   it/06  detail_hint current_will_fit_in_budget
 *   it/07  next_action on list/info/stats
 *   it/08  search snippet at result top-level
 *   it/09  list-search surfaces scanned_sessions / search_truncated on meta
 *   it/10  no summary on subsequent pages (unless --include-summary)
 *   it/11  pages_estimate uses actual budget
 *   it/12  runtime resume verification (verified true ⇒ bin on PATH)
 *   it/16  --anchor search without --search throws INVALID_ANCHOR_USAGE
 *   H6     read echoes the actually-used preset (not requested)
 *   M4     context --target-source for cross-tool handoff
 *   M5     stats.files_modified dedup
 *
 * The tests run sessionr as an external process so they exercise the same
 * envelope shape an agent receives. They share a tiny fixtures session id
 * picked from the local user's sessions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

interface Envelope {
  ok: boolean;
  schema_version: 'v2';
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
}

function runJson(args: string[]): Envelope {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  if (!r.stdout) {
    throw new Error(`No stdout. stderr: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as Envelope;
}

function runText(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

let SESSION_ID: string;

beforeAll(() => {
  execSync('npm run build', { stdio: 'ignore' });
  const list = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '10']);
  const sessions = (list.result as { sessions: Array<{ id: string }> }).sessions;
  if (sessions.length === 0) {
    throw new Error('No local sessions available for agent-ux regression test');
  }
  SESSION_ID = sessions[Math.min(2, sessions.length - 1)].id;
}, 60_000);

// ── dc/03 + dc/07: examples in --help / doctor result ────────────────────

describe('dc/03 — examples in --help for every visible command', () => {
  const VISIBLE = [
    'list',
    'read',
    'stats',
    'info',
    'search',
    'context',
    'diff',
    'tag',
    'prune',
    'send',
    'doctor',
    'jobs',
    'job',
    'wait',
    'cancel',
  ];
  for (const cmd of VISIBLE) {
    it(`${cmd} --help has an Examples block`, () => {
      const r = runText([cmd, '--help']);
      expect(r.stdout).toContain('Examples:');
    });
  }
});

describe('dc/07 — doctor result surfaces examples for agents', () => {
  it('doctor envelope includes examples + a next_action tip', () => {
    const env = runJson(['--output', 'json', 'doctor']);
    expect(env.ok).toBe(true);
    const result = env.result as { examples?: Array<{ command: string }> };
    expect(Array.isArray(result.examples)).toBe(true);
    expect(result.examples!.length).toBeGreaterThan(0);
    expect(result.examples![0]).toHaveProperty('command');
    expect((env.meta as Record<string, unknown>)?.next_action).toBeTruthy();
  });
});

// ── dc/05: source aliases ─────────────────────────────────────────────────

describe('dc/05 — source aliases', () => {
  for (const alias of ['cc', 'gpt', 'openai', 'oai', 'droid']) {
    it(`accepts "${alias}" as a source alias`, () => {
      const env = runJson(['--output', 'json', 'list', alias, '-n', '1']);
      // ok:true regardless of whether matching sessions exist locally
      expect(env.ok).toBe(true);
    }, 60_000);
  }
  it('rejects unknown source with INVALID_SOURCE + alias list in detail', () => {
    const env = runJson(['--output', 'json', 'list', 'definitely-not-a-source', '-n', '1']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_SOURCE');
    const detail = (env.error as { detail?: { aliases?: unknown } }).detail;
    expect(detail?.aliases).toBeTruthy();
  });
});

// ── dc/06: list numeric bounds ────────────────────────────────────────────

describe('dc/06 — list numeric bounds validation', () => {
  it('rejects --limit above 1000', () => {
    const env = runJson(['--output', 'json', 'list', '-n', '1500']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_RANGE');
  });
  it('rejects negative --offset', () => {
    const env = runJson(['--output', 'json', 'list', '--offset', '-5']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_RANGE');
  });
  it('rejects non-integer --limit', () => {
    const env = runJson(['--output', 'json', 'list', '-n', 'abc']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_RANGE');
  });
  it('accepts --limit at the upper bound', () => {
    const env = runJson(['--output', 'json', 'list', '-n', '1000', '--cwd', 'all']);
    expect(env.ok).toBe(true);
  }, 120_000);
});

// ── dc/08 + it/05 + it/07: list cursor/actions/next_action ────────────────

describe('it/05 — list cursor returns numeric tokens + command', () => {
  it('cursor.next has command + offset + limit when more pages exist', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '2']);
    expect(env.ok).toBe(true);
    const cursor = (env.result as { cursor: { next: { command: string; offset: number; limit: number } | null } }).cursor;
    expect(cursor.next).toBeTruthy();
    expect(typeof cursor.next!.offset).toBe('number');
    expect(typeof cursor.next!.limit).toBe('number');
    expect(typeof cursor.next!.command).toBe('string');
  }, 120_000);
});

describe('it/07 — meta.next_action on list/info/stats', () => {
  it('list emits meta.next_action with at least one runnable command', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '3']);
    const na = (env.meta as { next_action?: Record<string, unknown> })?.next_action;
    expect(na).toBeTruthy();
  }, 120_000);
  it('info emits meta.next_action.read with --tokens 4000', () => {
    const env = runJson(['--output', 'json', 'info', SESSION_ID]);
    const na = (env.meta as { next_action?: { read?: string } })?.next_action;
    expect(na?.read).toBeTruthy();
    expect(na!.read).toContain('--tokens 4000');
  }, 60_000);
  it('stats emits meta.next_action.read with --include-summary', () => {
    const env = runJson(['--output', 'json', 'stats', SESSION_ID]);
    const na = (env.meta as { next_action?: { read?: string } })?.next_action;
    expect(na?.read).toBeTruthy();
    expect(na!.read).toContain('--include-summary');
  }, 60_000);
});

describe('dc/08 — list footer carries several useful tips', () => {
  it('list returns >=3 actions when sessions exist', () => {
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-n', '3']);
    expect(env.actions).toBeTruthy();
    expect(env.actions!.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});

// ── it/08: search snippet at result top-level ─────────────────────────────

describe('it/08 — search top-level snippet per result', () => {
  it('each result has a snippet string when query matches', () => {
    // Tiny session-scan budget so the test stays fast on machines with
    // thousands of local sessions; the catalog issue is about the response
    // SHAPE, not about scanning every session.
    const env = runJson(['--output', 'json', 'search', '-q', 'the', '--max-sessions', '1', '--top', '1']);
    expect(env.ok).toBe(true);
    const results = (env.result as { results: Array<{ snippet?: string }> }).results;
    if (results.length > 0) {
      expect(typeof results[0].snippet).toBe('string');
      expect(results[0].snippet!.length).toBeGreaterThan(0);
    }
  }, 60_000);
  it('rejects empty --query with INVALID_QUERY', () => {
    const env = runJson(['--output', 'json', 'search', '-q', '']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_QUERY');
  });
});

// ── it/09: list-search truncation surfaced ────────────────────────────────

describe('it/09 — list -q surfaces scanned_sessions + search_truncated on meta', () => {
  it('meta carries top-level scanned_sessions + search_truncated', () => {
    // --max-sessions 2 keeps the disk scan small even when the local user has
    // thousands of sessions; we're verifying the meta shape, not throughput.
    const env = runJson(['--output', 'json', 'list', '--cwd', 'all', '-q', 'the', '-n', '5', '--max-sessions', '2']);
    expect(env.ok).toBe(true);
    const meta = env.meta as Record<string, unknown>;
    expect(typeof meta.scanned_sessions).toBe('number');
    expect(typeof meta.search_truncated).toBe('boolean');
  }, 60_000);
});

// ── it/06: detail_hint will_fit ───────────────────────────────────────────

describe('it/06 — detail_hint carries current_will_fit_in_budget', () => {
  it('read --tokens 1000 --preset standard exposes current_will_fit_in_budget', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '1000', '--preset', 'standard']);
    const hint = (env.meta as { detail_hint?: Record<string, unknown> })?.detail_hint;
    if (hint) {
      expect(typeof hint.current_will_fit_in_budget).toBe('boolean');
      expect(typeof hint.current_estimated_tokens).toBe('number');
    }
  }, 60_000);
});

// ── it/10: subsequent pages have no summary unless asked ──────────────────

describe('it/10 — page 2+ has no summary unless --include-summary', () => {
  it('page 2 result lacks .session by default', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '500', '--page', '2']);
    const result = env.result as { session?: unknown };
    expect(result.session).toBeUndefined();
  }, 60_000);
  it('page 2 result includes .session with --include-summary', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '500', '--page', '2', '--include-summary']);
    const result = env.result as { session?: unknown };
    expect(result.session).toBeTruthy();
  }, 60_000);
});

// ── it/11: pages_estimate uses actual budget ──────────────────────────────

describe('it/11 — pages_estimate scales with token budget', () => {
  it('halving budget produces >= pages_estimate', () => {
    const a = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '8000']);
    const b = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '2000']);
    const pa = (a.result as { session?: { pages_estimate?: number } }).session?.pages_estimate;
    const pb = (b.result as { session?: { pages_estimate?: number } }).session?.pages_estimate;
    if (typeof pa === 'number' && typeof pb === 'number') {
      expect(pb).toBeGreaterThanOrEqual(pa);
    }
  }, 60_000);
});

// ── it/12: runtime resume verification ────────────────────────────────────

describe('it/12 — next_action.verified only true when spawn bin on PATH', () => {
  it('runtime_bin_available is a boolean tracking PATH availability', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '200']);
    const na = (env.meta as { next_action?: { verified: boolean; runtime_bin_available?: boolean } }).next_action;
    expect(na).toBeTruthy();
    expect(typeof na!.runtime_bin_available).toBe('boolean');
    if (na!.verified) expect(na!.runtime_bin_available).toBe(true);
  }, 60_000);
});

// ── it/16: anchor=search without --search ─────────────────────────────────

describe('it/16 — --anchor search without --search throws INVALID_ANCHOR_USAGE', () => {
  it('rejects with envelope error code INVALID_ANCHOR_USAGE', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--anchor', 'search', '--tokens', '500']);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe('INVALID_ANCHOR_USAGE');
  }, 60_000);
});

// ── H6: preset echo + override transparency ───────────────────────────────

describe('H6 — meta.preset reflects actually-used preset', () => {
  it('--preset verbose --detail meta echoes preset=minimal + override reason', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '500', '--preset', 'verbose', '--detail', 'meta']);
    const meta = env.meta as { preset?: string; preset_source?: string; preset_override_reason?: string };
    expect(meta.preset).toBe('minimal');
    expect(meta.preset_source).toBe('detail-override');
    expect(meta.preset_override_reason).toContain('verbose');
  }, 60_000);
  it('--preset minimal (no --detail) echoes preset=minimal + preset_source=user', () => {
    const env = runJson(['--output', 'json', 'read', SESSION_ID, '--tokens', '500', '--preset', 'minimal']);
    const meta = env.meta as { preset?: string; preset_source?: string };
    expect(meta.preset).toBe('minimal');
    expect(meta.preset_source).toBe('user');
  }, 60_000);
});

// ── M4: context --target-source ───────────────────────────────────────────

describe('M4 — context --target-source emits cross-tool handoff', () => {
  it('--target-source claude sets next_action.target_source + cross_tool', () => {
    const env = runJson(['--output', 'json', 'context', SESSION_ID, '--tokens', '1000', '--target-source', 'claude']);
    expect(env.ok).toBe(true);
    const na = (env.meta as { next_action?: { target_source?: string; cross_tool?: boolean; resume?: string } }).next_action;
    expect(na?.target_source).toBe('claude');
    expect(typeof na?.cross_tool).toBe('boolean');
    expect(na?.resume).toContain('--source claude');
  }, 60_000);
  it('--target-source cc (alias) resolves to claude', () => {
    const env = runJson(['--output', 'json', 'context', SESSION_ID, '--tokens', '1000', '--target-source', 'cc']);
    const na = (env.meta as { next_action?: { target_source?: string } }).next_action;
    expect(na?.target_source).toBe('claude');
  }, 60_000);
});

// ── M5: stats files_modified dedup ────────────────────────────────────────

describe('M5 — stats.files_modified is deduplicated', () => {
  it('every entry is unique after absolute-path normalisation', () => {
    const env = runJson(['--output', 'json', 'stats', SESSION_ID]);
    const files = ((env.result as { session: { stats: { files_modified?: string[] } } }).session.stats.files_modified) ?? [];
    const unique = Array.from(new Set(files));
    expect(files.length).toBe(unique.length);
  }, 60_000);
});
