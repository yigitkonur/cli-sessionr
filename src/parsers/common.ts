import * as fs from 'fs';
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
