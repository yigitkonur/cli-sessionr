/**
 * dc/12: `sessionr docs [topic]` ships the bundled use-sessionr references
 * offline. Locks the v2 envelope shape + the topic-not-found path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');

function runJson(args: string[]): { obj: Record<string, unknown>; status: number | null } {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { obj: JSON.parse(r.stdout) as Record<string, unknown>, status: r.status };
}

beforeAll(() => {
  execSync('npm run build', { stdio: 'ignore' });
}, 60_000);

describe('docs command (dc/12)', () => {
  it('lists available topics as a v2 envelope', () => {
    const { obj, status } = runJson(['--output', 'json', 'docs']);
    expect(status).toBe(0);
    expect(obj.ok).toBe(true);
    expect(obj.schema_version).toBe('v2');
    const topics = (obj.result as { topics: Array<{ topic: string; title: string }> }).topics;
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
    // Every topic has a non-empty slug + human title.
    for (const t of topics) {
      expect(t.topic).toMatch(/^[a-z0-9-]+$/);
      expect(t.title.length).toBeGreaterThan(0);
    }
  });

  it('prints a specific topic with content', () => {
    // discover a real topic from the list first
    const list = runJson(['--output', 'json', 'docs']);
    const first = (list.obj.result as { topics: Array<{ topic: string }> }).topics[0].topic;
    const { obj, status } = runJson(['--output', 'json', 'docs', first]);
    expect(status).toBe(0);
    expect(obj.ok).toBe(true);
    const result = obj.result as { topic: string; content: string };
    expect(result.topic).toBe(first);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('unknown topic → TOPIC_NOT_FOUND v2 error envelope, exit 3', () => {
    const { obj, status } = runJson(['--output', 'json', 'docs', 'definitely-not-a-topic']);
    expect(status).toBe(3);
    expect(obj.ok).toBe(false);
    const err = obj.error as { code: string; class: string; detail?: { available?: string[] } };
    expect(err.code).toBe('TOPIC_NOT_FOUND');
    expect(err.class).toBe('not_found');
    expect(Array.isArray(err.detail?.available)).toBe(true);
  });
});
