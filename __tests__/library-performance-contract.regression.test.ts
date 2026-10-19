import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

it('does not label a 500ms fixture smoke as a 50ms guarantee', () => {
  const test = fs.readFileSync(path.join(__dirname, 'library-api.test.ts'), 'utf8');
  const discovery = fs.readFileSync(path.join(__dirname, '../src/discovery.ts'), 'utf8');
  expect(test).not.toMatch(/in under 50ms/);
  expect(discovery).not.toMatch(/Guarantees sub-50ms/);
});
