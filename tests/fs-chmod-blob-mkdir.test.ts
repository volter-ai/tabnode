/**
 * chmod on a missing path is ENOENT and a set mode is what stat reports;
 * openAsBlob answers a realm Blob of the file's bytes; mkdir of an existing
 * directory with a different mode is EEXIST.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

function guestWithFiles() {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/work' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/work/main.cjs').exports;
}

describe('fs chmod, openAsBlob and mkdir', () => {
  it('keeps the mode chmod sets and answers ENOENT for a missing path', async () => {
    const run = guestWithFiles();
    expect(await run(`
      const fs = require('fs');
      const fsp = require('fs/promises');
      return (async () => {
        fs.writeFileSync('/work/one.txt', 'hello');
        fs.chmodSync('/work/one.txt', 0o751);
        await fsp.chmod('/work/one.txt', 0o640);
        const missing = (fn) => { try { fn(); return 'no error'; } catch (error) { return error.code; } };
        return {
          mode: (fs.statSync('/work/one.txt').mode & 0o777).toString(8),
          chmodMissing: missing(() => fs.chmodSync('/work/gone.txt', 0o600)),
          chownMissing: missing(() => fs.chownSync('/work/gone.txt', 1000, 1000)),
        };
      })();
    `)).toEqual({ mode: '640', chmodMissing: 'ENOENT', chownMissing: 'ENOENT' });
  });

  it('opens a file as a Blob of its bytes', async () => {
    const run = guestWithFiles();
    expect(await run(`
      const fs = require('fs');
      return (async () => {
        fs.writeFileSync('/work/vectors', 'onetwo');
        const blob = await fs.openAsBlob('/work/vectors');
        return { text: await blob.text(), isBlob: blob instanceof Blob };
      })();
    `)).toEqual({ text: 'onetwo', isBlob: true });
  });

  it('throws EEXIST when an existing directory is created again with a different mode', () => {
    const run = guestWithFiles();
    expect(run(`
      const fs = require('fs');
      fs.mkdirSync('/work/shared', { recursive: true, mode: 0o755 });
      const first = (() => { try { fs.mkdirSync('/work/shared', { recursive: true, mode: 0o755 }); return 'ok'; } catch (e) { return e.code; } })();
      const second = (() => { try { fs.mkdirSync('/work/shared', { recursive: true, mode: 0o700 }); return 'ok'; } catch (e) { return e.code; } })();
      return { first, second };
    `)).toEqual({ first: 'ok', second: 'EEXIST' });
  });
});
