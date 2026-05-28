import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { cmdPrefix } from '../util/invocation.js';
import { SessionReaderError, exitCodeForError, EXIT } from '../errors.js';
import { success, failure } from '../output/envelope.js';
import { emit } from '../output/emit.js';
import type { OutputFormat } from '../types.js';

// dc/12: ship the bundled reference docs inside the CLI so agents can pull
// short markdown blocks (commands, sources, error-taxonomy, recipes, …)
// without a network round-trip. The reference files live at
// skills/use-sessionr/references/*.md and are listed in package.json `files`,
// so they are present in the published npm tarball.
//
// dist/commands/docs.js → <pkg>/dist/commands/docs.js, so ../../skills/...
// resolves the references in both the source tree and the published package.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCES_DIR = join(
  __dirname,
  '..',
  '..',
  'skills',
  'use-sessionr',
  'references',
);

interface DocTopic {
  topic: string;
  title: string;
  path: string;
}

/** Pull the first markdown H1 (`# Title`) as a human-readable title. */
function firstHeading(filePath: string, fallback: string): string {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^#\s+(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch {
    // fall through to the fallback name
  }
  return fallback;
}

/** Discover available topics from the bundled references directory. */
function discoverTopics(): DocTopic[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(REFERENCES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const topic = name.replace(/\.md$/, '');
      const path = join(REFERENCES_DIR, name);
      return { topic, title: firstHeading(path, topic), path };
    })
    .sort((a, b) => a.topic.localeCompare(b.topic));
}

export async function docsCommand(
  topic: string | undefined,
  opts: { output?: OutputFormat; timing?: boolean } = {},
): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false;
  const outputFormat: OutputFormat = opts.output ?? (isTTY ? 'text' : 'json');
  const isJson = outputFormat === 'json' || outputFormat === 'jsonl';

  try {
    const topics = discoverTopics();

    if (topics.length === 0) {
      throw new SessionReaderError(
        'Bundled documentation is unavailable in this installation',
        {
          code: 'DOCS_UNAVAILABLE',
          errorClass: 'internal',
          exitCode: EXIT.ERROR,
          suggestion: 'See https://github.com/yigitkonur/cli-sessionr',
          retry: false,
        },
      );
    }

    // No topic → list available topics.
    if (!topic) {
      const result = {
        topics: topics.map((t) => ({ topic: t.topic, title: t.title })),
      };
      if (isJson) {
        emit(
          success(result, {
            actions: topics.slice(0, 3).map((t) => ({
              command: `${cmdPrefix()} docs ${t.topic}`,
              description: `Print the "${t.title}" reference`,
            })),
          }),
          { format: outputFormat, timing: opts.timing },
        );
      } else {
        const lines = [
          'Available docs topics:',
          ...topics.map((t) => `  ${t.topic.padEnd(16)} ${t.title}`),
          '',
          `Run: ${cmdPrefix()} docs <topic>`,
        ];
        process.stdout.write(lines.join('\n') + '\n');
      }
      return;
    }

    // Specific topic → print its content.
    const match = topics.find((t) => t.topic === topic);
    if (!match) {
      throw new SessionReaderError(
        `Unknown docs topic: "${topic}"`,
        {
          code: 'TOPIC_NOT_FOUND',
          errorClass: 'not_found',
          exitCode: EXIT.NOT_FOUND,
          detail: { provided: topic, available: topics.map((t) => t.topic) },
          suggestion: `${cmdPrefix()} docs`,
          retry: false,
        },
      );
    }

    const content = fs.readFileSync(match.path, 'utf-8');

    if (isJson) {
      emit(
        success(
          { topic: match.topic, title: match.title, content },
          {
            actions: [
              { command: `${cmdPrefix()} docs`, description: 'List all docs topics' },
            ],
          },
        ),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      process.stdout.write(content + (content.endsWith('\n') ? '' : '\n'));
    }
  } catch (err) {
    if (isJson) {
      const isSre = err instanceof SessionReaderError;
      emit(
        failure({
          class: isSre ? err.class : 'internal',
          code: isSre ? err.code : 'DOCS_FAILED',
          message: err instanceof Error ? err.message : String(err),
          ...(isSre && Object.keys(err.detail).length > 0 ? { detail: err.detail } : {}),
          ...(isSre && err.suggestion ? { suggestion: err.suggestion } : {}),
          retryable: isSre ? err.retry : false,
        }),
        { format: outputFormat, timing: opts.timing },
      );
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(error.message + '\n');
    }
    process.exitCode = exitCodeForError(err);
  }
}
