import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { canSend, buildNewCommand, buildResumeCommand } from '../src/runners.js';

it('typechecks a custom adapter consumer without unsafe casts', () => {
  const root = path.resolve(__dirname, '..');
  expect(() => execFileSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
    '--strict', '--skipLibCheck', path.join(__dirname, 'typechecks/custom-source.mts'),
  ], { cwd: root, encoding: 'utf8', timeout: 30000 })).not.toThrow();
});

it('does not turn a custom reader source into an executable', () => {
  expect(canSend('custom-handoff')).toBe(false);
  expect(() => buildNewCommand('custom-handoff', 'synthetic')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }));
  expect(() => buildResumeCommand('custom-handoff', 'synthetic-id', 'synthetic')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }));
});
