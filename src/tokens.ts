import type { NormalizedMessage } from './types.js';

const CODE_INDICATORS = /[{};()=>\[\]<\/]|^\s{2,}\S/gm;
const CODE_THRESHOLD = 0.05;

function detectCodeRatio(text: string): number {
  if (!text) return 0;
  const matches = text.match(CODE_INDICATORS);
  if (!matches) return 0;
  return Math.min(matches.length / text.length, 1);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const codeRatio = detectCodeRatio(text);
  const isCode = codeRatio > CODE_THRESHOLD;
  const charsPerToken = isCode ? 3.5 : 4.0;
  return Math.ceil(text.length / charsPerToken);
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
