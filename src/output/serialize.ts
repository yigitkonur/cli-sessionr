import type { NormalizedMessage } from '../types.js';
import { estimateMessageTokens } from '../tokens.js';

export function serializeMessage(m: NormalizedMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    index: m.index,
    role: m.role,
    timestamp: m.timestamp,
    tokens_estimate: estimateMessageTokens(m),
    content: m.content,
  };

  if (m.blocks.length > 0 && m.content !== '' &&
      !(m.blocks.length === 1 && m.blocks[0].type === 'text')) {
    msg.blocks = m.blocks;
  }

  return msg;
}
