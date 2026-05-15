import { execSync } from 'node:child_process';

export function which(bin: string): string | null {
  try {
    const resolved = execSync(`command -v ${shellQuote(bin)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
