import type { SessionSource, SessionListEntry, NormalizedSession } from '../types.js';

export interface SourceAdapter {
  name: SessionSource;
  label: string;
  color: string;
  getDataDir(): string;
  find(): Promise<SessionListEntry[]>;
  parse(filePath: string): Promise<NormalizedSession>;
}

const registry: SourceAdapter[] = [];

// User-facing source-name aliases. Resolved on input only — the canonical
// SessionSource value is what gets stored on sessions and emitted in output.
const SOURCE_ALIASES: Record<string, SessionSource> = {
  droid: 'factory',
};

export function resolveSourceAlias(input: string | undefined): SessionSource | undefined {
  if (!input) return undefined;
  return (SOURCE_ALIASES[input] ?? input) as SessionSource;
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
