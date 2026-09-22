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

/** Every guest, including the first, owns its builtin graph. */
export function fsModuleFor(process: object): unknown {
  return loadNodeLibFor(process, 'fs');
}

export default fsModule;
