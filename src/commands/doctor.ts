import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

import '../parsers/index.js';
import { getAdapters } from '../parsers/registry.js';
import { isSqliteAvailable } from '../parsers/sqlite.js';
import { exitCodeForError } from '../errors.js';
import { which } from '../utils/which.js';
import type { OutputFormat, SessionSource } from '../types.js';

const SESSIONR_VERSION = '2.6.0';

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

export async function doctorCommand(opts?: { json?: boolean; output?: OutputFormat }): Promise<void> {
  const outputFormat = opts?.output ?? (opts?.json ? 'json' : ((process.stdout.isTTY ?? false) ? 'text' : 'json'));

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

    const envelope = {
      ok: true,
      schema_version: 'v1',
      result: {
        node_version: process.version,
        sessionr_version: SESSIONR_VERSION,
        cwd: process.cwd(),
        sources,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      console.log(formatText(sources, warnings));
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(error.message);
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
