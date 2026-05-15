import type { NormalizedMessage } from './types.js';

export interface SearchMatch {
  messageIndex: number;
  snippet: string;
  charOffset: number;
}

export function findSearchMatches(
  messages: NormalizedMessage[],
  query: string,
  maxMatches = 3,
): SearchMatch[] {
  const normalizedQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const message of messages) {
    const charOffset = message.content.toLowerCase().indexOf(normalizedQuery);
    if (charOffset === -1) continue;

    matches.push({
      messageIndex: message.index,
      snippet: ellipsize(message.content, 120, charOffset),
      charOffset,
    });

    if (matches.length >= maxMatches) break;
  }

  return matches;
}

export function ellipsize(text: string, len: number, hitOffset: number): string {
  if (text.length <= len) return text;

  const safeHitOffset = Math.max(0, Math.min(hitOffset, text.length));
  const half = Math.floor(len / 2);
  let start = Math.max(0, safeHitOffset - half);
  let end = Math.min(text.length, start + len);

  if (end - start < len) {
    start = Math.max(0, end - len);
  }

  const hasPrefix = start > 0;
  const hasSuffix = end < text.length;
  const prefixLen = hasPrefix ? 1 : 0;
  const suffixLen = hasSuffix ? 1 : 0;
  const bodyLen = Math.max(0, len - prefixLen - suffixLen);

  end = Math.min(text.length, start + bodyLen);
  start = adjustStartToWordBoundary(text, start, safeHitOffset);
  end = adjustEndToWordBoundary(text, end, safeHitOffset);

  if (end <= start) {
    start = Math.max(0, safeHitOffset - Math.floor(bodyLen / 2));
    end = Math.min(text.length, start + bodyLen);
  }

  return `${hasPrefix ? '…' : ''}${text.slice(start, end).trim()}${hasSuffix ? '…' : ''}`;
}

function adjustStartToWordBoundary(text: string, start: number, hitOffset: number): number {
  if (start === 0 || /\s/.test(text[start] ?? '') || start >= hitOffset) return start;

  const nextSpace = text.indexOf(' ', start);
  if (nextSpace === -1 || nextSpace >= hitOffset) return start;

  return nextSpace + 1;
}

function adjustEndToWordBoundary(text: string, end: number, hitOffset: number): number {
  if (end >= text.length || /\s/.test(text[end] ?? '') || end <= hitOffset) return end;

  const previousSpace = text.lastIndexOf(' ', end);
  if (previousSpace === -1 || previousSpace <= hitOffset) return end;

  return previousSpace;
}
