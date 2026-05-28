import * as crypto from 'node:crypto';
import type { NormalizedSession } from './types.js';

export interface ETagOptions {
  preset?: string;
  tokenBudget?: number;
  from?: number;
  to?: number;
  anchor?: string;
  search?: string;
  page?: number;
  format?: string;
}

export function computeETag(session: NormalizedSession, opts: ETagOptions = {}): string {
  // MEDIUM-7 (adversarial review): the etag previously hashed only metadata
  // (updatedAt + totalMessages) + view params, so two sessions with identical
  // metadata but different message bodies produced the SAME etag — an agent
  // polling with --if-changed would get exit 42 (no-changes) even though the
  // content changed (e.g. an in-place tool-result rewrite, or a file rewritten
  // with identical mtime/count). We now fold in the actual content: file size,
  // raw line count, and a digest of every message's role + content + block
  // shape. md5 is non-cryptographic but fine + fast for change detection.
  const hash = crypto.createHash('md5');
  hash.update([
    session.metadata.updatedAt.toISOString(),
    session.stats.totalMessages,
    session.metadata.fileBytes ?? '',
    session.metadata.rawLineCount ?? '',
    opts.preset ?? '',
    opts.tokenBudget ?? '',
    `${opts.from ?? ''}..${opts.to ?? ''}`,
    opts.anchor ?? '',
    opts.search ?? '',
    opts.page ?? '',
    opts.format ?? '',
  ].join('|'));

  // Content digest: role + content + per-block-type signature for each message.
  // This makes the etag sensitive to in-place content changes that leave the
  // metadata counters untouched.
  for (const m of session.messages) {
    hash.update('\x1e'); // record separator
    hash.update(m.role);
    hash.update('\x1f'); // unit separator
    hash.update(m.content);
    for (const b of m.blocks) {
      hash.update('\x1f');
      hash.update(b.type);
      if (b.type === 'text' || b.type === 'thinking') hash.update(b.text);
      else if (b.type === 'tool_use') hash.update(`${b.id}:${b.name}`);
      else if (b.type === 'tool_result') hash.update(`${b.toolUseId}:${String(b.isError)}:${b.content}`);
    }
  }

  return hash.digest('hex').slice(0, 16);
}
