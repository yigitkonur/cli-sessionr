import type { SessionSource, SessionListEntry, NormalizedSession } from '../types.js';

export interface SourceAdapter {
  name: SessionSource;
  label: string;
  color: string;
  find(): Promise<SessionListEntry[]>;
  parse(filePath: string): Promise<NormalizedSession>;
}

const registry: SourceAdapter[] = [];

export function registerSource(adapter: SourceAdapter): void {
  // Replace if already registered (for tests/hot-reload)
  const idx = registry.findIndex((a) => a.name === adapter.name);
  if (idx >= 0) registry[idx] = adapter;
  else registry.push(adapter);
}

export function getAdapters(source?: SessionSource): SourceAdapter[] {
  if (!source) return [...registry];
  return registry.filter((a) => a.name === source);
}

export function getAdapter(source: SessionSource): SourceAdapter | undefined {
  return registry.find((a) => a.name === source);
}

export function getAllLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const a of registry) labels[a.name] = a.label;
  return labels;
}
