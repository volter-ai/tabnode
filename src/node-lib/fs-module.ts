/**
 * `fs` and `fs/promises`, as Node's own `fs.js`.
 *
 * What died: the engine's `fs` was a hand-written 1,764-line imitation of
 * Node's whole `fs` layer over the virtual filesystem. Node's own
 * `test-fs-*`: 52 of 246 passed.
 *
 * What this is: Node's `lib/fs.js` and the nine `internal/fs/*` files
 * v22.18.0, vendored unmodified, on `./binding/fs.ts` -- the forty
 * operations libuv would make, over the engine's tree. `Stats`, `Dirent`,
 * `ReadStream`, `WriteStream`, `FileHandle`, `opendir`, `rm -rf`'s retries,
 * `mkdtemp`'s template, glob and every error message are Node's own code.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyModule } from './lazy';
import { loadNodeLibFor } from './load';

export const fsModule = lazyModule<Record<string, unknown>>('fs');
export const fsPromisesModule = lazyModule<Record<string, unknown>>('internal/fs/promises');

/**
 * `require('fs')` for one guest process. The first process in the realm is
 * handed the already-built module; a later process gets a file compiled for
 * it, so a tag on the module object is that process's.
 */
const byProcess = new WeakMap<object, unknown>();
let firstProcess: object | null = null;
export function fsModuleFor(process: object): unknown {
  const held = byProcess.get(process);
  if (held !== undefined) return held;
  let module: unknown;
  if (firstProcess === null || firstProcess === process) {
    firstProcess = process;
    module = fsModule;
  } else {
    module = loadNodeLibFor(process, 'fs');
  }
  byProcess.set(process, module);
  return module;
}

export default fsModule;
