/**
 * Optional SQLite helper for parsers that need database access (Goose, Zed).
 * Uses node:sqlite (Node 22+) with graceful degradation.
 */

let sqliteAvailable: boolean | null = null;
let warnedOnce = false;

export function isSqliteAvailable(): boolean {
  if (sqliteAvailable !== null) return sqliteAvailable;
  try {
    require('node:sqlite');
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

export interface SqliteRow {
  [key: string]: unknown;
}

export function queryAll(dbPath: string, sql: string, params: unknown[] = []): SqliteRow[] {
  if (!isSqliteAvailable()) {
    if (!warnedOnce) {
      console.error('[sessionr] SQLite requires Node 22+. Some sessions may not be available.');
      warnedOnce = true;
    }
    return [];
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as SqliteRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
