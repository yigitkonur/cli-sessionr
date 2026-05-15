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
  const input = [
    session.metadata.updatedAt.toISOString(),
    session.stats.totalMessages,
    opts.preset ?? '',
    opts.tokenBudget ?? '',
    `${opts.from ?? ''}..${opts.to ?? ''}`,
    opts.anchor ?? '',
    opts.search ?? '',
    opts.page ?? '',
    opts.format ?? '',
  ].join('|');
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 16);
}
