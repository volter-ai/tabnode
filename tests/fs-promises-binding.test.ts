/**
 * `fs.promises` answers a promise, because the binding does.
 *
 * Node's binding has three flavours on the same call: a value, a callback
 * through a request object, and a promise when the last argument is
 * `kUsePromises`. `internal/fs/promises.js` uses the third for every call it
 * makes and hands what comes back to `PromisePrototypeThen`, so a binding
 * that answered the value read as `TypeError: Method Promise.prototype.then
 * called on incompatible receiver [object Float64Array]` -- the Float64Array
 * being the stat fields `readFileHandle` asks for first. Every program's
 * `fs.promises.readFile` failed that way; openvscode-server read its own
 * `nls.messages.json` with it, threw `!!! NLS MISSING: 1875 !!!` out of a
 * module load, and died after binding its port. Measured in the substrate's
 * tab on v0.2.14-volter.61 through the page's shell.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

function tree(): VirtualFS {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/work', { recursive: true });
  vfs.writeFileSync('/work/messages.json', JSON.stringify({ hello: 'world' }));
  return vfs;
}

describe('the fs binding’s promise flavour', () => {
  it('reads a file back through fs.promises', async () => {
    const vfs = tree();
    vfs.writeFileSync('/work/main.js', `
      const fs = require('fs');
      module.exports.done = (async () => {
        const text = await fs.promises.readFile('/work/messages.json', 'utf8');
        const bytes = await fs.promises.readFile('/work/messages.json');
        const stat = await fs.promises.stat('/work/messages.json');
        return [JSON.parse(text).hello, bytes.length === text.length, stat.isFile(), stat.size];
      })();
    `);
    const result = await new Runtime(vfs, { cwd: '/work' }).runFileAsync('/work/main.js');
    const seen = await (result.exports as { done: Promise<unknown[]> }).done;
    expect(seen).toEqual(['world', true, true, 17]);
  });

  it('writes, lists and stats a tree through fs.promises', async () => {
    const vfs = tree();
    vfs.writeFileSync('/work/main.js', `
      const fs = require('fs');
      module.exports.done = (async () => {
        await fs.promises.writeFile('/work/written.txt', 'one');
        await fs.promises.appendFile('/work/written.txt', 'two');
        await fs.promises.mkdir('/work/nested/deep', { recursive: true });
        const names = (await fs.promises.readdir('/work')).sort();
        const handle = await fs.promises.open('/work/written.txt', 'r');
        const stat = await handle.stat();
        await handle.close();
        return [await fs.promises.readFile('/work/written.txt', 'utf8'), names.includes('nested'), stat.size];
      })();
    `);
    const result = await new Runtime(vfs, { cwd: '/work' }).runFileAsync('/work/main.js');
    const seen = await (result.exports as { done: Promise<unknown[]> }).done;
    expect(seen).toEqual(['onetwo', true, 6]);
  });
});
