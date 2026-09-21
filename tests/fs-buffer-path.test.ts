// Node accepts a path as string, Buffer or URL. The binding must take each as
// given and, when encoding is `buffer`, answer Buffer names. rimraf (fs.rm
// recursive) readdir's with encoding `buffer` and Buffer.concat's the child
// name onto the path; a string child threw
// `The "list[1]" argument must be an instance of Buffer or Uint8Array.
// Received type string ('exthost1')`.
import { describe, expect, it } from 'vitest';
import { Runtime, VirtualFS } from '../src/index';

function guest(): (body: string) => unknown {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/work' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/work/main.cjs').exports;
}

describe('a path as Buffer, string or URL, and readdir encoding buffer', () => {
  it('mkdir of a Buffer path, a string child, and the promise form, then rm recursive of a tree named exthost1', async () => {
    const run = guest();
    expect(await run(`
      const fs = require('fs');
      const { Buffer } = require('buffer');
      const { pathToFileURL } = require('url');
      return (async () => {
        fs.mkdirSync(Buffer.from('/work/a'), { recursive: true });
        fs.mkdirSync('/work/a/exthost1', { recursive: true });
        fs.writeFileSync('/work/a/exthost1/x.txt', 'x');
        await fs.promises.mkdir(Buffer.from('/work/a/exthost1/child'), { recursive: true });
        fs.writeFileSync('/work/a/exthost1/child/y.txt', 'y');
        const names = fs.readdirSync('/work/a', { encoding: 'buffer' });
        const types = names.map((n) => ({
          isBuffer: Buffer.isBuffer(n),
          text: Buffer.isBuffer(n) ? n.toString() : String(n),
        }));
        const fromUrl = fs.existsSync(pathToFileURL('/work/a/exthost1/x.txt'));
        let rm = 'ok';
        try { fs.rmSync('/work/a', { recursive: true, force: true }); }
        catch (error) { rm = error.name + ':' + error.message; }
        return { made: fs.existsSync('/work/a') === false, types, fromUrl, rm };
      })();
    `)).toEqual({
      made: true,
      types: [{ isBuffer: true, text: 'exthost1' }],
      fromUrl: true,
      rm: 'ok',
    });
  });
});
