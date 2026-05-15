import type { SessionSource, SessionListEntry, NormalizedSession } from '../types.js';
import { resolveSource } from '../utils/validate.js';

export interface SourceAdapter {
  name: SessionSource;
  label: string;
  color: string;
  find(): Promise<SessionListEntry[]>;
  parse(filePath: string): Promise<NormalizedSession>;
}

const registry: SourceAdapter[] = [];

export function resolveSourceAlias(input: string | undefined): SessionSource | undefined {
  return resolveSource(input);
}

export function registerSource(adapter: SourceAdapter): void {
  // Replace if already registered (for tests/hot-reload)
  const idx = registry.findIndex((a) => a.name === adapter.name);
  if (idx >= 0) registry[idx] = adapter;
  else registry.push(adapter);
}

export function getAdapters(source?: string): SourceAdapter[] {
  const resolved = resolveSourceAlias(source);
  if (!resolved) return [...registry];
  return registry.filter((a) => a.name === resolved);
}

export function getAdapter(source: string): SourceAdapter | undefined {
  const resolved = resolveSourceAlias(source);
  if (!resolved) return undefined;
  return registry.find((a) => a.name === resolved);
}

export function getAllLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const a of registry) labels[a.name] = a.label;
  return labels;
}
