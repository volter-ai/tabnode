/**
 * A descriptor opened for reading holds the file from its first read.
 *
 * Node's `fs.readFile` issues 512 KiB (`kReadFileBufferLength`) async
 * `read`s. The binding used to call `tree.readFileSync` on every one, so a
 * 20 MB file was forty whole-file trips to the store. openvscode-server's
 * extension host stalled on a cold boot of `extensionHostProcess.js` before
 * it could send ready. A kernel page cache answers later `read`s on that
 * fd from memory; this file is that, measured by counting store trips.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

const SIZE = 20 * 1024 * 1024;

describe('a descriptor opened for reading holds the file from its first read', () => {
  it('fs.readFile of a 20 MB file is one store trip', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/opt', { recursive: true });
    vfs.writeFileSync('/opt/big.bin', new Uint8Array(SIZE).fill(1));

    let trips = 0;
    const original = vfs.readFileSync.bind(vfs);
    vfs.readFileSync = ((path: string, encoding?: 'utf8' | 'utf-8') => {
      if (path === '/opt/big.bin') trips += 1;
      return encoding === undefined ? original(path) : original(path, encoding);
    }) as VirtualFS['readFileSync'];

    const started = Date.now();
    const listed = new Runtime(vfs, { cwd: '/' }).execute(`
      const fs = require('fs');
      module.exports = new Promise((resolve, reject) => {
        fs.readFile('/opt/big.bin', (err, data) => err ? reject(err) : resolve(data.length));
      });
    `).exports as Promise<number>;

    await expect(listed).resolves.toBe(SIZE);
    const ms = Date.now() - started;
    expect(trips).toBe(1);
    expect(ms).toBeLessThan(5_000);
  });
});
