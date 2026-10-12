import type { SessionSource, SessionListEntry, NormalizedSession } from '../types.js';
import { resolveSource } from '../utils/validate.js';

export interface SourceAdapter {
  name: SessionSource | (string & {});
  label: string;
  color: string;
  getDataDir?(): string;
  find(): Promise<SessionListEntry[]>;
  parse(filePath: string): Promise<NormalizedSession>;
}

const registry: SourceAdapter[] = [];

export function resolveSourceAlias(input: string | undefined): SessionSource | undefined {
  if (!input) return undefined;
  const s = input.toLowerCase();
  const custom = registry.find((a) => a.name.toLowerCase() === s);
  if (custom) return custom.name as SessionSource;
  try {
    return resolveSource(input);
  } catch {
    return undefined;
  }
}

export function registerSource(adapter: SourceAdapter): void {
  // Replace if already registered (for tests/hot-reload)
  const idx = registry.findIndex((a) => a.name.toLowerCase() === adapter.name.toLowerCase());
  if (idx >= 0) registry[idx] = adapter;
  else registry.push(adapter);
}

export function getAdapters(source?: string): SourceAdapter[] {
  if (!source) return [...registry];
  const direct = registry.filter((a) => a.name.toLowerCase() === source.toLowerCase());
  if (direct.length > 0) return direct;
  const resolved = resolveSourceAlias(source);
  if (!resolved) return [];
  return registry.filter((a) => a.name.toLowerCase() === resolved.toLowerCase());
}

export function getAdapter(source: string): SourceAdapter | undefined {
  if (!source) return undefined;
  const s = source.toLowerCase();
  const direct = registry.find((a) => a.name.toLowerCase() === s);
  if (direct) return direct;
  const resolved = resolveSourceAlias(source);
  if (!resolved) return undefined;
  return registry.find((a) => a.name.toLowerCase() === resolved.toLowerCase());
}

export function getAllLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const a of registry) labels[a.name] = a.label;
  return labels;
}
