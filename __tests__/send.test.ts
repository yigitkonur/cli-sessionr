import { describe, it, expect, vi } from 'vitest';
import { spawnAndWait } from '../src/commands/send.js';

describe('send spawnAndWait', () => {
  it('mirrors child pipes to stderr and captures the last 50 lines per stream', async () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      });

    try {
      const script = `
        for (let i = 1; i <= 55; i++) console.log('stdout-' + i);
        for (let i = 1; i <= 55; i++) console.error('stderr-' + i);
        process.exit(7);
      `;
      const result = await spawnAndWait(
        { bin: process.execPath, args: ['-e', script] },
        process.cwd(),
      );

      expect(result.exitCode).toBe(7);
      expect(writes.join('')).toContain('stdout-1');
      expect(writes.join('')).toContain('stderr-55');
      expect(result.stdoutTail).toHaveLength(50);
      expect(result.stderrTail).toHaveLength(50);
      expect(result.stdoutTail[0]).toBe('stdout-6');
      expect(result.stdoutTail[49]).toBe('stdout-55');
      expect(result.stderrTail[0]).toBe('stderr-6');
      expect(result.stderrTail[49]).toBe('stderr-55');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
