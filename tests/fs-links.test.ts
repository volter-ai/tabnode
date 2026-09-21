/**
 * The tab's filesystem holds no links, and fs says so rather than pretending:
 * `symlinkSync` and `linkSync` refuse with EPERM, `readlinkSync` answers
 * EINVAL for a path that is not a link and ENOENT for one that is not there,
 * and nothing is left behind by the refusal.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { createFsShim } from '../src/shims/fs';

function guestWithFiles() {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/work' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/work/main.cjs').exports;
}

describe('the tab has no links, and fs says so rather than pretending', () => {
  it('refuses symlink and link with EPERM and leaves nothing behind', () => {
    const run = guestWithFiles();
    const result = run(`
      const fs = require("fs");
      fs.writeFileSync("/work/real.txt", "real");
      const caught = (fn) => { try { fn(); return { code: "none" }; } catch (error) { return { code: error.code, message: error.message }; } };
      return {
        symlink: caught(() => fs.symlinkSync("/work/real.txt", "/work/link")),
        link: caught(() => fs.linkSync("/work/real.txt", "/work/hard")),
        readlinkOfFile: caught(() => fs.readlinkSync("/work/real.txt")).code,
        readlinkOfNothing: caught(() => fs.readlinkSync("/work/gone")).code,
        leftBehind: fs.existsSync("/work/link") || fs.existsSync("/work/hard")
      };
    `) as Record<string, { code: string; message: string } | string | boolean>;
    expect((result.symlink as { code: string }).code).toBe('EPERM');
    expect((result.symlink as { message: string }).message).toMatch(/the tab's filesystem holds no links/);
    expect((result.link as { code: string }).code).toBe('EPERM');
    expect((result.link as { message: string }).message).toMatch(/the tab's filesystem holds no links/);
    expect(result.readlinkOfFile).toBe('EINVAL');
    expect(result.readlinkOfNothing).toBe('ENOENT');
    expect(result.leftBehind).toBe(false);
  });

  it('refuses through the callback and promise forms too', async () => {
    const vfs = new VirtualFS();
    const fs = createFsShim(vfs, () => '/');
    vfs.writeFileSync('/real.txt', 'real');
    const callbackError = await new Promise<{ code?: string }>((resolve) => {
      (fs as unknown as { symlink: (a: string, b: string, cb: (e: { code?: string }) => void) => void })
        .symlink('/real.txt', '/link', resolve);
    });
    expect(callbackError.code).toBe('EPERM');
    await expect(fs.promises.symlink('/real.txt', '/link')).rejects.toMatchObject({ code: 'EPERM' });
    await expect(fs.promises.link('/real.txt', '/hard')).rejects.toMatchObject({ code: 'EPERM' });
    expect(fs.existsSync('/link')).toBe(false);
  });

  it('goes through to a filesystem that says it holds links', () => {
    const vfs = new VirtualFS();
    (vfs as unknown as { holdsLinks: boolean }).holdsLinks = true;
    const fs = createFsShim(vfs, () => '/');
    fs.writeFileSync('/real.txt', 'real');
    fs.symlinkSync('/real.txt', '/link');
    expect(fs.readlinkSync('/link')).toBe('/real.txt');
    expect(fs.readFileSync('/link', 'utf8')).toBe('real');
  });

  it('answers a missing path with undefined under throwIfNoEntry: false, as Node does', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    const fs = createFsShim(vfs);
    expect(fs.statSync('/app/absent', { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync('/app/absent', { throwIfNoEntry: false })).toBeUndefined();
    expect(() => fs.statSync('/app/absent')).toThrow(/ENOENT/);
    expect(fs.statSync('/app', { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  });
});
