import { cmdPrefix } from '../util/invocation.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadSession } from '../discovery.js';
import { createFormatter } from '../output/formatter.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import { exitCodeForError, SessionReaderError, EXIT } from '../errors.js';
import type { SessionSource, OutputFormat, V2Action } from '../types.js';

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
    timing?: boolean;
  },
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (opts.json ? 'json' : (isTTY ? 'text' : 'json'));
  const formatter = createFormatter({
    output: opts.output,
    json: opts.json,
    isTTY,
  });

  try {
    // Verify session exists
    const session = await loadSession(
      sessionId,
      opts.source as SessionSource | undefined,
    );

    if (!opts.add && !opts.remove) {
      throw new SessionReaderError('Must specify --add or --remove', {
        code: 'USAGE_ERROR',
        errorClass: 'validation',
        exitCode: EXIT.USAGE,
        suggestion: `${cmdPrefix()} tag ${sessionId} --add "my-tag"`,
      });
    }

    const allTags = loadTags();
    const sessionTags = allTags[session.id] ?? [];
    const tagSet = new Set(sessionTags);

    const added: string[] = [];
    const removed: string[] = [];
    if (opts.add) {
      if (!tagSet.has(opts.add)) added.push(opts.add);
      tagSet.add(opts.add);
    }
    if (opts.remove) {
      if (tagSet.has(opts.remove)) removed.push(opts.remove);
      tagSet.delete(opts.remove);
    }

    allTags[session.id] = [...tagSet];
    saveTags(allTags);

    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const prefix = cmdPrefix();
      const result: Record<string, unknown> = {
        session_id: session.id,
        tags: [...tagSet],
      };
      if (added.length > 0) result.added = added;
      if (removed.length > 0) result.removed = removed;

      const actions: V2Action[] = [
        { command: `${prefix} info ${session.id}`, description: 'View session metadata' },
        { command: `${prefix} read ${session.id}`, description: 'Read session messages' },
      ];
      emit(success(result, { actions }), {
        format: outputFormat,
        timing: opts.timing,
      });
    } else {
      process.stdout.write(`Tags for ${session.id}: ${[...tagSet].join(', ') || '(none)'}\n`);
    }
  } catch (err) {
    if (outputFormat === 'json' || outputFormat === 'jsonl') {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'TAG_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(formatter.error(error) + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}
