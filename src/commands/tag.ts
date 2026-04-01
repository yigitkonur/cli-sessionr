import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadSession } from '../discovery.js';
import { exitCodeForError, SessionReaderError, EXIT } from '../errors.js';
import type { SessionSource, OutputFormat } from '../types.js';

const TAGS_DIR = path.join(os.homedir(), '.sessionreader');
const TAGS_FILE = path.join(TAGS_DIR, 'tags.json');

function loadTags(): Record<string, string[]> {
  try {
    if (fs.existsSync(TAGS_FILE)) {
      return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    }
  } catch {
    // corrupt file, start fresh
  }
  return {};
}

function saveTags(tags: Record<string, string[]>): void {
  if (!fs.existsSync(TAGS_DIR)) {
    fs.mkdirSync(TAGS_DIR, { recursive: true });
  }
  fs.writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2));
}

export async function tagCommand(
  sessionId: string,
  opts: {
    add?: string;
    remove?: string;
    source?: string;
    json?: boolean;
    output?: OutputFormat;
  },
): Promise<void> {
  try {
    // Verify session exists
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );

    if (!opts.add && !opts.remove) {
      throw new SessionReaderError('Must specify --add or --remove', {
        code: 'USAGE_ERROR',
        exitCode: EXIT.USAGE,
        suggestion: `sessionr tag ${sessionId} --add "my-tag"`,
      });
    }

    const allTags = loadTags();
    const sessionTags = allTags[session.id] ?? [];
    const tagSet = new Set(sessionTags);

    if (opts.add) {
      tagSet.add(opts.add);
    }
    if (opts.remove) {
      tagSet.delete(opts.remove);
    }

    allTags[session.id] = [...tagSet];
    saveTags(allTags);

    const result = {
      api_version: 1,
      status: 'ok',
      session_id: session.id,
      tags: [...tagSet],
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(
      JSON.stringify({ error: { code: 'TAG_FAILED', message: error.message } }),
    );
    process.exitCode = exitCodeForError(err);
  }
}
