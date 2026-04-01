import { getEncoding } from 'js-tiktoken';
import type { NormalizedMessage } from './types.js';

const enc = getEncoding('cl100k_base');

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return enc.encode(text).length;
}

export function estimateMessageTokens(msg: NormalizedMessage): number {
  let tokens = 4; // overhead: role, separators
  for (const block of msg.blocks) {
    switch (block.type) {
      case 'text':
      case 'thinking':
        tokens += estimateTokens(block.text);
        break;
      case 'tool_use':
        tokens += estimateTokens(block.name);
        tokens += estimateTokens(JSON.stringify(block.input));
        break;
      case 'tool_result':
        tokens += estimateTokens(block.content);
        break;
    }
  }
  return tokens;
}

export function estimateSessionTokens(messages: NormalizedMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
