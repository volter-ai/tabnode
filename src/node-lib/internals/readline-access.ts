/**
 * The engine's `readline`, read on the first ask.
 *
 * `internal/fs/promises.js` takes `Interface` from `internal/readline/
 * interface` at its top, so every use of `fs/promises` needs the class.
 * `readline`'s own `Interface` extends the vendored `EventEmitter`, and this
 * file is on the loader's path, so the name is read when it is wanted rather
 * than when this module is evaluated -- the rule `../lazy.ts` states.
 */
import { nodeLibInternalRequire } from '../load';

export function readlineModule(): Record<string, unknown> {
  // Node's own `internal/readline/interface` is vendored now, so the name
  // resolves to that file rather than to the engine's shim.
  return nodeLibInternalRequire('internal/readline/interface') as Record<string, unknown>;
}
