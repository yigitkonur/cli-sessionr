import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import '../parsers/index.js';
import { getAdapters } from '../parsers/registry.js';
import { isSqliteAvailable } from '../parsers/sqlite.js';
import { SessionReaderError, exitCodeForError } from '../errors.js';
import { which } from '../utils/which.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import type { OutputFormat, SessionSource } from '../types.js';

// Read version from package.json at module init so semantic-release bumps
// propagate without code changes. dist/commands/doctor.js lives at
// <pkg>/dist/commands/doctor.js, so ../../package.json resolves to the root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONR_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as { version: string }
).version;

const SPAWN_BINS: Record<SessionSource, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
  'cursor-agent': 'cursor-agent',
  commandcode: 'commandcode',
  goose: 'goose',
  opencode: 'opencode',
  kiro: 'kiro',
  zed: 'zed',
  factory: 'factory',
};

interface DoctorSource {
  name: SessionSource;
  data_dir: string;
  data_dir_exists: boolean;
  session_count: number;
  spawn_bin: string;
  spawn_bin_resolvable: boolean;
  spawn_bin_path?: string;
}

export async function doctorCommand(opts?: {
  json?: boolean;
  output?: OutputFormat;
  timing?: boolean;
}): Promise<void> {
  const outputFormat: OutputFormat =
    opts?.output ?? (opts?.json ? 'json' : ((process.stdout.isTTY ?? false) ? 'text' : 'json'));

  try {
    const warnings: string[] = [];
    const sources: DoctorSource[] = [];

    for (const adapter of getAdapters()) {
      const dataDir = adapter.getDataDir();
      const spawnBin = SPAWN_BINS[adapter.name];
      const spawnBinPath = which(spawnBin);
      let sessionCount = 0;

      try {
        sessionCount = (await adapter.find()).length;
      } catch (err) {
        warnings.push(`${adapter.name}: ${String(err instanceof Error ? err.message : err)}`);
      }

      sources.push({
        name: adapter.name,
        data_dir: dataDir,
        data_dir_exists: fs.existsSync(dataDir),
        session_count: sessionCount,
        spawn_bin: spawnBin,
        spawn_bin_resolvable: spawnBinPath !== null,
        ...(spawnBinPath ? { spawn_bin_path: spawnBinPath } : {}),
      });
    }

    if (!isSqliteAvailable()) {
      warnings.push('goose/zed: node:sqlite unavailable; SQLite-backed sessions cannot be read on this Node version');
    }
    if (!hasNativeZstd() && !which('zstd')) {
      warnings.push('zed: zstd support unavailable; compressed Zed messages cannot be parsed');
    }

    // dc/07: examples so agents reading doctor output can self-discover the
    // canonical next commands without re-fetching `--help`. These mirror the
    // examples in cli.ts so the two stay in sync visually.
    const examples = [
      { command: 'sessionr list --cwd all', description: 'List sessions across all directories' },
      { command: 'sessionr read <id> --tokens 4000', description: 'Read first page of a session' },
      { command: 'sessionr search -q "deploy"', description: 'Find sessions by content' },
      { command: 'sessionr send <id> -f prompt.md --async', description: 'Resume a session in the background' },
      { command: 'sessionr context <id> --tokens 8000', description: 'Export context for cross-tool handoff' },
    ];

    const usableSources = sources.filter((s) => s.session_count > 0).map((s) => s.name);
    const missingBins = sources.filter((s) => !s.spawn_bin_resolvable).map((s) => s.name);

    const result = {
      node_version: process.version,
      sessionr_version: SESSIONR_VERSION,
      cwd: process.cwd(),
      sources,
      // dc/07: surface high-leverage follow-ups inside the result so callers
      // that only read `.result` (not `.actions`) still see them.
      examples,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const actions = [
        ...(usableSources.length > 0
          ? [{
              command: `sessionr list ${usableSources[0]}`,
              description: `List sessions from ${usableSources[0]} (has ${sources.find((s) => s.name === usableSources[0])?.session_count ?? 0} sessions)`,
            }]
          : []),
        { command: 'sessionr list --cwd all', description: 'List sessions across every directory' },
        { command: 'sessionr help --output json', description: 'Full machine-readable command help' },
      ];
      const nextAction = {
        list: 'sessionr list --cwd all',
        help: 'sessionr help --output json',
        tip:
          missingBins.length > 0
            ? `Spawn binaries missing for: ${missingBins.join(', ')}. Install before sessionr send to those sources.`
            : 'All spawn binaries on PATH. Use sessionr send <id> --async for long-running resume.',
      };
      emit(
        success(result, { meta: { cwd: process.cwd(), next_action: nextAction }, actions }),
        {
          format: outputFormat,
          timing: opts?.timing,
        },
      );
    } else {
      // Text path retained verbatim from v2.9; full text polish is Phase 3.
      process.stdout.write(formatText(sources, warnings) + '\n');
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'DOCTOR_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts?.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(error.message + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}

function hasNativeZstd(): boolean {
  return typeof (zlib as Record<string, unknown>)['zstdDecompressSync'] === 'function';
}

function formatText(sources: DoctorSource[], warnings: string[]): string {
  const lines = [
    `sessionr ${SESSIONR_VERSION}`,
    `node ${process.version}`,
    '',
    ...sources.map((s) => {
      const dir = s.data_dir_exists ? 'dir ok' : 'dir missing';
      const bin = s.spawn_bin_resolvable ? `bin ${s.spawn_bin_path}` : `bin ${s.spawn_bin} missing`;
      return `${s.name}: ${s.session_count} sessions, ${dir}, ${bin}`;
    }),
  ];
  if (warnings.length > 0) {
    lines.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
  }
  return lines.join('\n');
}
