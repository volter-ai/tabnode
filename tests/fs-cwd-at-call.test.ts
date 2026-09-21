/**
 * The fs binding resolves a relative path against the calling run's cwd.
 *
 * Node's `fs.js` hands the binding the path as written; libuv resolves it
 * against the process's cwd. VirtualFS.normalizePath used to turn a relative
 * name into `/<name>`, so a guest whose `process.cwd()` was `/workspace`
 * wrote `made.txt` at `/made.txt` and `readdirSync('.')` listed the root.
 * The cwd is captured at the call's entry together with the tree, because
 * a later tick can see another run's process.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('the fs binding resolves a relative path against the caller’s cwd', () => {
  it('a guest at /workspace writes made.txt there, and a second guest at /other sees its own', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/workspace', { recursive: true });
    vfs.mkdirSync('/other', { recursive: true });

    const writer = new Runtime(vfs, { cwd: '/workspace' });
    const listed = writer.execute(`
      const fs = require('fs');
      fs.writeFileSync('made.txt', 'in workspace');
      module.exports.cwd = process.cwd();
      module.exports.absolute = fs.readFileSync('/workspace/made.txt', 'utf8');
      module.exports.promised = fs.promises.readFile('made.txt', 'utf8');
      module.exports.names = fs.readdirSync('.');
      module.exports.dir = (async () => {
        const dir = await fs.promises.opendir('.');
        const names = [];
        for await (const entry of dir) names.push(entry.name);
        return names;
      })();
    `).exports as {
      cwd: string;
      absolute: string;
      promised: Promise<string>;
      names: string[];
      dir: Promise<string[]>;
    };

    expect(listed.cwd).toBe('/workspace');
    expect(listed.absolute).toBe('in workspace');
    expect(listed.names).toContain('made.txt');
    await expect(listed.promised).resolves.toBe('in workspace');
    await expect(listed.dir).resolves.toContain('made.txt');

    const other = new Runtime(vfs, { cwd: '/other' }).execute(`
      const fs = require('fs');
      fs.writeFileSync('made.txt', 'in other');
      module.exports.mine = fs.readFileSync('made.txt', 'utf8');
      module.exports.theirs = fs.readFileSync('/workspace/made.txt', 'utf8');
      module.exports.here = fs.readdirSync('.');
      module.exports.rootHasMade = fs.existsSync('/made.txt');
    `).exports as {
      mine: string;
      theirs: string;
      here: string[];
      rootHasMade: boolean;
    };

    expect(other.mine).toBe('in other');
    expect(other.theirs).toBe('in workspace');
    expect(other.here).toContain('made.txt');
    expect(other.here).not.toContain('workspace');
    expect(other.rootHasMade).toBe(false);
  });
});
