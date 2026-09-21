/**
 * The fs binding reads the run's tree at the call, not when the async work
 * lands.
 *
 * Since .56 the tree hangs off the process whose code is executing, and since
 * .62 `fs.promises` and the callback flavour complete on a later tick. A later
 * tick can see another run's process -- another run's view, or none -- so a
 * file `ls` lists (synchronous readdir) is ENOENT through `tail` and `open`.
 * Two guests share one tree; the first writes and stays running, the second
 * reads through both async flavours, and another run takes the realm's process
 * before those reads land. Both reads still have to answer.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('the fs binding’s tree is the caller’s', () => {
  it('an async read from a second guest sees the file the first wrote, while the first is still running', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace', { recursive: true });
    const writer = new Runtime(vfs, { cwd: '/workspace' });
    const reader = new Runtime(vfs, { cwd: '/workspace' });

    writer.execute(`
      const fs = require('fs');
      fs.writeFileSync('/workspace/made.txt', 'by a process');
      setInterval(() => {}, 10_000);
    `);

    const listed = reader.execute(`
      const fs = require('fs');
      module.exports.names = fs.readdirSync('/workspace');
      module.exports.sync = fs.readFileSync('/workspace/made.txt', 'utf8');
      module.exports.promised = fs.promises.readFile('/workspace/made.txt', 'utf8');
      module.exports.callback = new Promise((resolve, reject) => {
        fs.readFile('/workspace/made.txt', 'utf8', (err, data) => err ? reject(err) : resolve(data));
      });
    `).exports as {
      names: string[];
      sync: string;
      promised: Promise<string>;
      callback: Promise<string>;
    };

    expect(listed.names).toContain('made.txt');
    expect(listed.sync).toBe('by a process');

    // Another run takes the realm's process, as a second guest in the tab does
    // between a call and its tick. Its tree is empty; the file is not there.
    new Runtime(new VirtualFS(), { cwd: '/' }).execute('void 0');

    await expect(listed.promised).resolves.toBe('by a process');
    await expect(listed.callback).resolves.toBe('by a process');
  });
});
