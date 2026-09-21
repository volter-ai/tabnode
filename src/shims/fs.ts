/**
 * `createFsShim`: Node's own `fs`, over a tree a caller names.
 *
 * This file was 1,764 lines: a hand-written imitation of Node's whole `fs`
 * layer -- every validation, every encoding, `Stats`, `Dirent`, the streams,
 * the promises and the error messages -- over the engine's virtual
 * filesystem. v0.2.14-volter.56 made a guest's `require('fs')` Node's own
 * file on a binding, and the imitation stayed only because the engine's own
 * parts still called it. This is what they call, and nothing more.
 *
 * WHO CALLS IT, and why it cannot simply be the module: Node's `fs` is one
 * module for the whole engine and reads its tree off the process of the run
 * whose code is executing. Three callers have a tree but are not a run --
 * the engine hands WASI one, the substrate builds with rolldown over a
 * project's, and the Next dev server reads one -- so each call made through
 * here names its tree for the length of that call, and inside it Node's own
 * `fs` runs unchanged.
 */
import { fsModule } from '../node-lib/fs-module';
import { withFilesystem } from '../node-lib/binding/fs';
import type { VirtualFS } from '../virtual-fs';

/** Node's `fs`, as a caller of `createFsShim` reads it. */
export type FsShim = Record<string, unknown> & {
  promises: Record<string, unknown>;
};

/** One function, or one nested object of them, bound to a tree. */
function boundTo(tree: VirtualFS, value: unknown): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]): unknown => withFilesystem(tree, () => (value as (...a: unknown[]) => unknown)(...args));
  }
  // `fs.promises` and `fs.constants` are objects of their own; the first
  // needs the same binding, the second is numbers.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return new Proxy(value as object, {
      get: (target, key) => boundTo(tree, Reflect.get(target, key)),
    });
  }
  return value;
}

/**
 * Node's `fs` is an ordinary module object, and a program may define on it:
 * `graceful-fs` -- which half of npm loads, openvscode-server through
 * `fs-extra` and `@vscode/deviceid` -- writes its queue onto the module with
 * `Object.defineProperty(fs, Symbol.for('graceful-fs.queue'), { get() {…} })`
 * and then clones the module, which walks its keys. Every trap below read the
 * module and none read the proxy's own target, so a guest's define landed
 * where nothing looked: the read came back `undefined`, `key in fs` answered
 * false for a key the target held non-configurable, and `Reflect.ownKeys(fs)`
 * threw `'ownKeys' on proxy: trap result did not include
 * 'Symbol(graceful-fs.queue)'` -- a proxy may not hide a non-configurable own
 * key of its target. graceful-fs threw out of its own module load, and every
 * program that loads it died there: in the substrate's tab that was
 * openvscode-server's server at boot and its extension host, which exited 1
 * without a word because a forked host's console goes to its parent over IPC.
 *
 * What a guest writes is the guest's, and what it did not write is the
 * module's; the guest global's proxy in `src/runtime.ts` answers the same way.
 */
export function createFsShim(tree: VirtualFS, _getCwd?: () => string): FsShim {
  const own = (target: object, key: PropertyKey): boolean =>
    Reflect.getOwnPropertyDescriptor(target, key) !== undefined;
  return new Proxy({} as FsShim, {
    get: (target, key, receiver) => (own(target, key)
      ? Reflect.get(target, key, receiver)
      : boundTo(tree, Reflect.get(fsModule as object, key))),
    has: (target, key) => own(target, key) || Reflect.has(fsModule as object, key),
    ownKeys: (target) => {
      const keys = Reflect.ownKeys(target);
      for (const key of Reflect.ownKeys(fsModule as object)) if (!keys.includes(key)) keys.push(key);
      return keys;
    },
    getOwnPropertyDescriptor: (target, key) => {
      const mine = Reflect.getOwnPropertyDescriptor(target, key);
      if (mine !== undefined) return mine;
      const descriptor = Reflect.getOwnPropertyDescriptor(fsModule as object, key);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
  });
}

export default createFsShim;
