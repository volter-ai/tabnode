/**
 * `repl`: a STAND-IN, not Node's `lib/repl.js`.
 *
 * It carries the module's surface (the names `lib/repl.js` exports in Node 24)
 * so a program that loads `repl` for a name it uses elsewhere starts: ts-node
 * imports it at the top of a file its entry loads on every run, script or
 * REPL. It carries no REPL. `start()` and `new REPLServer()` refuse by name.
 *
 * What is Node's own here: `Recoverable` (a SyntaxError holding the error it
 * wraps), `writer` (`util.inspect` with `showProxy`), the two mode symbols'
 * descriptions, and `builtinModules`. What is not: the server.
 *
 * Why it is not Node's file: `lib/repl.js` requires Node's own CommonJS and
 * ESM loaders (`internal/modules/cjs/loader`, `internal/modules/esm/loader`),
 * `internal/vm` and the `contextify` binding, `internal/repl/await` over
 * acorn, `internal/process/execution` and `domain`; counted from Node 24.21.0
 * that is about a hundred internal files the engine does not carry, the two
 * loaders among them, which the engine replaces with its own (BUILTINS.md,
 * `module`). The REPL comes with those, not before.
 */

import utilModule from '../node-lib/util-module';
import { builtinModules as builtinNames } from './module';

const refuse = (what: string): never => {
  throw Object.assign(new Error(`${what}: the REPL is not carried by this engine (repl is a stand-in for Node's surface; see BUILTINS.md)`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};

/** Node's `Recoverable`: input that is incomplete, not wrong. */
export class Recoverable extends SyntaxError {
  err: unknown;
  constructor(err: unknown) {
    super();
    this.err = err;
  }
}

export const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
export const REPL_MODE_STRICT = Symbol('repl-strict');

type Inspect = ((value: unknown, options?: object) => string) & { defaultOptions?: object };
// Read when asked, never as this file loads: `util` is a lazy export and loading it here is a cycle with the loader.
const inspect = (): Inspect => (utilModule as unknown as { inspect: Inspect }).inspect;
let writerOptions: object | undefined;
export const writer = ((value: unknown): string => inspect()(value, writer.options)) as ((value: unknown) => string) & { options: object };
Object.defineProperty(writer, 'options', {
  configurable: true,
  enumerable: true,
  get(): object { return writerOptions ??= { ...(inspect().defaultOptions ?? {}), showProxy: true }; },
  set(value: object) { writerOptions = value; },
});

export class REPLServer {
  constructor() {
    refuse('new repl.REPLServer()');
  }
}

export function start(): never {
  return refuse('repl.start()');
}

/** Node's deprecated `repl.builtinModules`: the builtin names that do not begin with an underscore. */
export const builtinModules: string[] = builtinNames.filter((name) => !name.startsWith('_'));
export const _builtinLibs = builtinModules;

export default { start, writer, REPLServer, REPL_MODE_SLOPPY, REPL_MODE_STRICT, Recoverable, builtinModules, _builtinLibs };
