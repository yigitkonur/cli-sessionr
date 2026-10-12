import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

/**
 * Read an entire JSONL file into an array.
 * Invalid lines are silently skipped.
 */
export async function readJsonlFile<T = unknown>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];

  return new Promise((resolve) => {
    const items: T[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        items.push(JSON.parse(line));
      } catch {
        // skip invalid lines
      }
    });

    rl.on('close', () => resolve(items));
    rl.on('error', () => resolve(items));
  });
}

/**
 * Scan the first N lines of a JSONL file with an early-stop visitor.
 */
export async function scanJsonlHead(
  filePath: string,
  maxLines: number,
  visitor: (parsed: unknown, lineIndex: number) => 'continue' | 'stop',
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineIndex = 0;
    let stopped = false;

    rl.on('line', (line) => {
      if (stopped || lineIndex >= maxLines) {
        if (!stopped) {
          stopped = true;
          rl.close();
          stream.close();
        }
        return;
      }

      try {
        const parsed = JSON.parse(line);
        if (visitor(parsed, lineIndex) === 'stop') {
          stopped = true;
          rl.close();
          stream.close();
        }
      } catch {
        // skip
      }

      lineIndex++;
    });

    rl.on('close', () => resolve());
    rl.on('error', () => resolve());
  });
}

/**
 * Count lines and get byte size for a file.
 */
export async function getFileStats(filePath: string): Promise<{ lines: number; bytes: number }> {
  const stats = fs.statSync(filePath);

  return new Promise((resolve) => {
    let lines = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', () => lines++);
    rl.on('close', () => resolve({ lines, bytes: stats.size }));
    rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
  });
}

/**
 * Read a single JSON file and parse it. Returns null if file doesn't exist or parse fails.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Truncate a string with ellipsis if it exceeds max length.
 */
export function truncate(s: string, max: number): string {
  if (!s || max === Infinity || s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return s.slice(0, max - 3) + '...';
}

/**
 * Recursively find files matching a predicate.
 */
export function findFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth = 10,
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = `${currentDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && predicate(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Resolves an environment variable path with trimming, tilde expansion,
 * and relative-to-absolute resolution via path.resolve().
 * Falls back to defaultPath if envVal is undefined or empty/whitespace.
 */
export function resolveEnvPath(envVal: string | undefined, defaultPath: string): string {
  if (!envVal) return defaultPath;
  const trimmed = envVal.trim();
  if (!trimmed) return defaultPath;
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmed.slice(1).replace(/^[/\\]/, ''));
  }
  return path.resolve(trimmed);
}

/**
 * Safely parse an arbitrary timestamp value into a guaranteed-valid Date instance.
 *
 * Guarantees that the returned Date is never `Invalid Date` (NaN), preventing
 * downstream `RangeError: Invalid time value` crashes during JSON serialization.
 */
export function parseDefensiveTimestamp(ts: unknown, fallback?: Date): Date {
  const safeFallback = fallback instanceof Date && !isNaN(fallback.getTime()) ? fallback : new Date();
  if (ts == null) return safeFallback;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? safeFallback : ts;

  if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts <= 0) return safeFallback;
    const ms = ts < 1e11 ? Math.round(ts * 1000) : Math.round(ts);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? safeFallback : d;
  }

  if (typeof ts === 'string') {
    const trimmed = ts.trim();
    if (!trimmed) return safeFallback;

    // Check if purely numeric string (e.g. epoch ms or epoch s)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        const ms = num < 1e11 ? Math.round(num * 1000) : Math.round(num);
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return d;
      }
    }

    // Direct Date.parse for ISO-8601 or standard formats
    let parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) return new Date(parsed);

    const normalized = trimmed.replace(/\.(\d{3})\d+([Z+-]|$)/, '.$1$2');
    parsed = Date.parse(normalized);
    if (!isNaN(parsed)) return new Date(parsed);
  }

  return safeFallback;
}
