import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

/**
 * Rolldown's native side is a wasm binding the page loads, not the installed
 * package's stub: a guest that required `rolldown` got the stub and the build
 * never ran. The page registers the binding on the filesystem the package is
 * installed in, keyed by the file the package's own `exports` name, and the
 * engine's `require` answers with it. Resolution, the manifest and the version
 * are the installed package's own, and another filesystem is untouched.
 */
const NATIVE_MODULES = Symbol.for('@volter/browser-node/rolldown-modules');

function installRolldown(vfs: VirtualFS): void {
  vfs.mkdirSync('/work/node_modules/rolldown/dist', { recursive: true });
  vfs.writeFileSync('/work/node_modules/rolldown/package.json', JSON.stringify({
    name: 'rolldown',
    version: '1.2.7',
    exports: { '.': './dist/index.cjs', './parseAst': './dist/parse.cjs' },
  }));
  vfs.writeFileSync('/work/node_modules/rolldown/dist/index.cjs', 'module.exports = {source:"installed"};');
  vfs.writeFileSync('/work/node_modules/rolldown/dist/parse.cjs', 'module.exports = {source:"installed parser"};');
  vfs.writeFileSync('/work/check.cjs', 'module.exports = {api:require("rolldown"), parser:require("rolldown/parseAst"), path:require.resolve("rolldown")};');
}

function register(vfs: VirtualFS): Map<string, (process: unknown) => unknown> {
  const modules = new Map<string, (process: unknown) => unknown>();
  modules.set('/work/node_modules/rolldown/dist/index.cjs', (process: any) => ({ source: 'binding', cwd: process.cwd() }));
  modules.set('/work/node_modules/rolldown/dist/parse.cjs', () => ({ source: 'parser' }));
  Reflect.set(vfs, NATIVE_MODULES, modules);
  return modules;
}

describe('a registered native module, keyed per filesystem', () => {
  it('answers the installed export path while resolution stays the installed one', () => {
    const vfs = new VirtualFS();
    installRolldown(vfs);
    register(vfs);
    const exports = new Runtime(vfs, { cwd: '/work' }).runFile('/work/check.cjs').exports as any;
    expect(exports.api.source).toBe('binding');
    expect(exports.parser.source).toBe('parser');
    expect(exports.path).toBe('/work/node_modules/rolldown/dist/index.cjs');
  });

  it('is local to its filesystem: another one loads the installed file', () => {
    const registered = new VirtualFS();
    const other = new VirtualFS();
    for (const vfs of [registered, other]) installRolldown(vfs);
    register(registered);
    expect((new Runtime(other).runFile('/work/check.cjs').exports as any).api.source).toBe('installed');
    expect((new Runtime(registered).runFile('/work/check.cjs').exports as any).api.source).toBe('binding');
  });

  it('makes the module for the process that asked, so each guest keeps its own cwd', () => {
    const vfs = new VirtualFS();
    installRolldown(vfs);
    register(vfs);
    const first = new Runtime(vfs, { cwd: '/work' }).runFile('/work/check.cjs').exports as any;
    const later = new Runtime(vfs, { cwd: '/elsewhere' }).runFile('/work/check.cjs').exports as any;
    expect(first.api.cwd).toBe('/work');
    expect(later.api.cwd).toBe('/elsewhere');
  });

  it('withdraws with the registration: a cleared map loads the installed file again', () => {
    const vfs = new VirtualFS();
    installRolldown(vfs);
    const modules = register(vfs);
    expect((new Runtime(vfs).runFile('/work/check.cjs').exports as any).api.source).toBe('binding');
    modules.clear();
    expect((new Runtime(vfs).runFile('/work/check.cjs').exports as any).api.source).toBe('installed');
    Reflect.deleteProperty(vfs, NATIVE_MODULES);
    expect((new Runtime(vfs).runFile('/work/check.cjs').exports as any).api.source).toBe('installed');
  });

  it('leaves an export path the registration does not name to the installed file', () => {
    const vfs = new VirtualFS();
    installRolldown(vfs);
    const modules = register(vfs);
    modules.delete('/work/node_modules/rolldown/dist/parse.cjs');
    const exports = new Runtime(vfs, { cwd: '/work' }).runFile('/work/check.cjs').exports as any;
    expect(exports.api.source).toBe('binding');
    expect(exports.parser.source).toBe('installed parser');
  });
});
