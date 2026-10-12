import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSessionByPath } from '../src/index.js';

it('closes the sniff descriptor when reading a directory fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fd-'));
  const opened: number[] = [];
  const closed: number[] = [];
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const open = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    opened.push(fd);
    return fd;
  });
  const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
    closed.push(fd);
    originalClose(fd);
  });
  try {
    await expect(loadSessionByPath(dir)).rejects.toMatchObject({ code: 'SESSION_FILE_READ_FAILED' });
    expect(opened).toHaveLength(1);
    expect(closed).toEqual(opened);
  } finally {
    open.mockRestore();
    close.mockRestore();
    for (const fd of opened.filter((fd) => !closed.includes(fd))) originalClose(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
