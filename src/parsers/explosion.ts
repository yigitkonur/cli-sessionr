/**
 * Shared content block explosion logic.
 * Used by Claude Code, Command Code, and any parser with text/thinking/tool_use/tool_result blocks.
 */
import type { ContentBlock, NormalizedMessage } from '../types.js';

// ── Raw block interface (from Claude/CommandCode JSONL) ─────────────────────

export interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  [key: string]: unknown;
}

// ── Exploded message (intermediate before indexing) ─────────────────────────

export interface ExplodedMessage {
  role: NormalizedMessage['role'];
  content: string;
  blocks: ContentBlock[];
  timestamp: Date;
  rawLineIndex: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && b.text)
      .map((b: { text?: string }) => b.text!)
      .join('\n');
  }
  return '';
}

export function isSystemInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<permissions') ||
    trimmed.startsWith('<context_window') ||
    trimmed.startsWith('<user_instructions>')
  );
}

export function cleanPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const clean = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
  return clean || null;
}

// ── Explosion: assistant message ────────────────────────────────────────────

export function explodeAssistantBlocks(
  blocks: RawBlock[],
  timestamp: Date,
  lineIndex: number,
): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const textBlocks: ContentBlock[] = [];
  let textContent = '';

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const text = block.text || '';
        if (text.trim()) {
          textBlocks.push({ type: 'text', text });
          textContent += (textContent ? '\n' : '') + text;
        }
        break;
      }

      case 'thinking': {
        const text = block.thinking || block.text || '';
        if (text.trim()) {
          textBlocks.push({ type: 'thinking', text });
        }
        break;
      }

      case 'tool_use': {
        // Flush accumulated text+thinking before tool_use
        if (textBlocks.length > 0) {
          results.push({
            role: 'assistant',
            content: textContent,
            blocks: [...textBlocks],
            timestamp,
            rawLineIndex: lineIndex,
          });
          textBlocks.length = 0;
          textContent = '';
        }

        const toolBlock: ContentBlock = {
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: (block.input as Record<string, unknown>) || {},
        };
        results.push({
          role: 'tool_use',
          content: `Tool: ${block.name || 'unknown'}`,
          blocks: [toolBlock],
          timestamp,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'tool_result': {
        const resultContent = extractToolResultContent(block.content);
        results.push({
          role: 'tool_result',
          content: resultContent,
          blocks: [{
            type: 'tool_result',
            toolUseId: block.tool_use_id || '',
            content: resultContent,
            isError: block.is_error === true,
          }],
          timestamp,
          rawLineIndex: lineIndex,
        });
        break;
      }

      default:
        break;
    }
  }

  // Flush remaining text+thinking
  if (textBlocks.length > 0) {
    results.push({
      role: 'assistant',
      content: textContent,
      blocks: [...textBlocks],
      timestamp,
      rawLineIndex: lineIndex,
    });
  }

  return results;
}

// ── Explosion: user message ─────────────────────────────────────────────────

export function explodeUserBlocks(
  blocks: RawBlock[],
  timestamp: Date,
  lineIndex: number,
): ExplodedMessage[] {
  const results: ExplodedMessage[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'tool_result': {
        const resultContent = extractToolResultContent(block.content);
        results.push({
          role: 'tool_result',
          content: resultContent,
          blocks: [{
            type: 'tool_result',
            toolUseId: block.tool_use_id || '',
            content: resultContent,
            isError: block.is_error === true,
          }],
          timestamp,
          rawLineIndex: lineIndex,
        });
        break;
      }

      case 'text': {
        const text = block.text || '';
        if (text.trim() && !isSystemInjectedText(text)) {
          textParts.push(text);
        }
        break;
      }

      default:
        break;
    }
  }

  if (textParts.length > 0) {
    const joined = textParts.join('\n');
    results.push({
      role: 'user',
      content: joined,
      blocks: textParts.map((t) => ({ type: 'text' as const, text: t })),
      timestamp,
      rawLineIndex: lineIndex,
    });
  }

  return results;
}

// ── Convert ExplodedMessages to indexed NormalizedMessages ───────────────────

export function indexMessages(exploded: ExplodedMessage[]): NormalizedMessage[] {
  return exploded.map((e, i) => ({
    index: i + 1,
    role: e.role,
    timestamp: e.timestamp,
    content: e.content,
    blocks: e.blocks,
    rawLineIndex: e.rawLineIndex,
  }));
}
