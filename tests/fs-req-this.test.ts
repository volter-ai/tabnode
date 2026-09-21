/**
 * The callback flavour of an fs request keeps the request as `this`.
 *
 * Node's `readFileAfterOpen` is installed as `req.oncomplete` on an
 * `FSReqCallback` whose `.context` is the `ReadFileContext`. The binding
 * invokes it as a method (`req.oncomplete(err, fd)` with `this === req`).
 * d1da169 captured the function and called it detached, so `this` was
 * undefined and a guest `fs.readFile(path, cb)` threw
 * `TypeError: Cannot read properties of undefined (reading 'context')`
 * at `node:fs:297:24` — openvscode-server died of it on a cold boot, and
 * seven of Node's own `test-fs-*` files did too.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('the callback flavour of an fs request keeps the request as this', () => {
  it('readFile, readFile with encoding, and open+fstat callbacks answer', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace', { recursive: true });
    vfs.writeFileSync('/workspace/x.txt', 'from the tree');
    const listed = new Runtime(vfs, { cwd: '/workspace' }).execute(`
      const fs = require('fs');
      module.exports.plain = new Promise((resolve, reject) => {
        fs.readFile('/workspace/x.txt', (err, data) => err ? reject(err) : resolve(data.toString()));
      });
      module.exports.encoded = new Promise((resolve, reject) => {
        fs.readFile('/workspace/x.txt', 'utf8', (err, data) => err ? reject(err) : resolve(data));
      });
      module.exports.opened = new Promise((resolve, reject) => {
        fs.open('/workspace/x.txt', 'r', (openErr, fd) => {
          if (openErr) return reject(openErr);
          fs.fstat(fd, (statErr, st) => {
            if (statErr) return reject(statErr);
            fs.close(fd, (closeErr) => closeErr ? reject(closeErr) : resolve({ size: st.size, isFile: st.isFile() }));
          });
        });
      });
    `).exports as {
      plain: Promise<string>;
      encoded: Promise<string>;
      opened: Promise<{ size: number; isFile: boolean }>;
    };

    await expect(listed.plain).resolves.toBe('from the tree');
    await expect(listed.encoded).resolves.toBe('from the tree');
    await expect(listed.opened).resolves.toEqual({ size: 'from the tree'.length, isFile: true });
  });
});
