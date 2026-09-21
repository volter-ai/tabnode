// A program can define a property on `require('fs')`, read it back, and
// enumerate the module.
//
// Node's `fs` is an ordinary module object. `graceful-fs` -- which
// openvscode-server loads through `fs-extra` and `@vscode/deviceid`, and which
// half of npm loads -- defines `Symbol.for('graceful-fs.queue')` on it with
// `Object.defineProperty(fs, sym, { get() { return queue } })` and then clones
// the module, which enumerates it. The engine answered `fs` with a proxy over
// an empty target that read every trap from the module and never from the
// target, so the define landed on the target where nothing looked: the read
// came back `undefined`, and `Reflect.ownKeys(fs)` threw
// `TypeError: 'ownKeys' on proxy: trap result did not include
// 'Symbol(graceful-fs.queue)'` -- a proxy must report every non-configurable
// own key of its target. graceful-fs threw out of its own module load, so
// every program that loads it died there. Measured in the substrate's tab on
// v0.2.14-volter.62: the server logged that TypeError at boot and its
// extension host exited 1 without a word, because a forked host's console goes
// to its parent over IPC and the server drops those messages.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

describe('a guest defining on the fs module', () => {
  it('reads it back, enumerates it, and can clone the module', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    vfs.writeFileSync('/work/main.js',
      "const fs = require('fs');\n"
      + "const s = Symbol.for('graceful-fs.queue');\n"
      + "const queue = [];\n"
      + "Object.defineProperty(fs, s, { get() { return queue; } });\n"
      + "console.log('read ' + Array.isArray(fs[s]));\n"
      + "console.log('has ' + (s in fs));\n"
      + "console.log('desc ' + !!Object.getOwnPropertyDescriptor(fs, s));\n"
      + "let keys = 'threw';\n"
      + "try { keys = String(Reflect.ownKeys(fs).includes(s)); } catch (error) { keys = 'threw: ' + error.message; }\n"
      + "console.log('keys ' + keys);\n"
      // What graceful-fs does next: clone the module, which walks its keys.
      + "let cloned = 'threw';\n"
      + "try { const copy = {}; for (const key of Object.getOwnPropertyNames(fs)) copy[key] = fs[key]; cloned = String(typeof copy.readFileSync === 'function'); }\n"
      + "catch (error) { cloned = 'threw: ' + error.message; }\n"
      + "console.log('cloned ' + cloned);\n"
      + "console.log('still fs ' + (typeof fs.readFileSync));\n");
    const seen = await createContainer({ vfs }).run('node /work/main.js', { cwd: '/work' });
    expect(seen.stdout).toContain('read true');
    expect(seen.stdout).toContain('has true');
    expect(seen.stdout).toContain('desc true');
    expect(seen.stdout).toContain('keys true');
    expect(seen.stdout).toContain('cloned true');
    expect(seen.stdout).toContain('still fs function');
  }, 20_000);
});
