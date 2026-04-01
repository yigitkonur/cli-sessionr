import { getEncoding } from 'js-tiktoken';
import type { NormalizedMessage, VerbosityPreset } from './types.js';

const enc = getEncoding('cl100k_base');

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return enc.encode(text).length;
}

export function estimateMessageTokens(msg: NormalizedMessage): number {
  let tokens = 4;
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

export function estimateRenderedMessageTokens(msg: NormalizedMessage, preset: VerbosityPreset): number {
  let tokens = 4;
  for (const block of msg.blocks) {
    switch (block.type) {
      case 'text': {
        const text = preset.maxContentChars === Infinity
          ? block.text
          : block.text.slice(0, preset.maxContentChars);
        tokens += estimateTokens(text);
        break;
      }
      case 'thinking': {
        if (!preset.showThinking) break;
        const text = preset.maxThinkingChars === Infinity
          ? block.text
          : block.text.slice(0, preset.maxThinkingChars);
        tokens += estimateTokens(text);
        break;
      }
      case 'tool_use': {
        tokens += estimateTokens(block.name);
        if (preset.showToolArgs) {
          const raw = JSON.stringify(block.input);
          const text = preset.maxToolInputChars === Infinity
            ? raw
            : raw.slice(0, preset.maxToolInputChars);
          tokens += estimateTokens(text);
        }
        break;
      }
      case 'tool_result': {
        if (!preset.showToolResults) break;
        const text = preset.maxToolResultChars === Infinity
          ? block.content
          : block.content.slice(0, preset.maxToolResultChars);
        tokens += estimateTokens(text);
        break;
      }
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

export function estimateRenderedSessionTokens(messages: NormalizedMessage[], preset: VerbosityPreset): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateRenderedMessageTokens(msg, preset);
  }
  return total;
}
