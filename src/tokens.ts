import type { NormalizedMessage, VerbosityPreset } from './types.js';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
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
        const len = preset.maxContentChars === Infinity
          ? block.text.length
          : Math.min(block.text.length, preset.maxContentChars);
        tokens += Math.ceil(len / 4);
        break;
      }
      case 'thinking': {
        if (!preset.showThinking) break;
        const len = preset.maxThinkingChars === Infinity
          ? block.text.length
          : Math.min(block.text.length, preset.maxThinkingChars);
        tokens += Math.ceil(len / 4);
        break;
      }
      case 'tool_use': {
        tokens += Math.ceil(block.name.length / 4);
        if (preset.showToolArgs) {
          const raw = JSON.stringify(block.input);
          const len = preset.maxToolInputChars === Infinity
            ? raw.length
            : Math.min(raw.length, preset.maxToolInputChars);
          tokens += Math.ceil(len / 4);
        }
        break;
      }
      case 'tool_result': {
        if (!preset.showToolResults) break;
        const len = preset.maxToolResultChars === Infinity
          ? block.content.length
          : Math.min(block.content.length, preset.maxToolResultChars);
        tokens += Math.ceil(len / 4);
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
