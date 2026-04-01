import * as crypto from 'crypto';
import type { NormalizedSession } from './types.js';

export function computeETag(session: NormalizedSession): string {
  const input = `${session.metadata.updatedAt.toISOString()}:${session.stats.totalMessages}`;
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 16);
}
