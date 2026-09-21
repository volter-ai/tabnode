/**
 * The small modules that are Node's own file and a binding of the realm's.
 *
 * Each one here was a hand-written imitation in `src/shims/`, and each is now
 * `nodejs/node` v22.18.0's own file: `assert` with its `AssertionError`,
 * `CallTracker` and the whole of `deepStrictEqual`; `querystring`, whose
 * escaping and parsing are its own; `punycode`, which is one pure algorithm;
 * `constants`; and `diagnostics_channel`, whose subscription and
 * `TracingChannel` semantics every observability library reads.
 *
 * `domain` is not here, and its own entry in the module table says why.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyModule, lazyExport } from './lazy';

/** `assert` is a callable module -- `assert(value)` is `assert.ok(value)`. */
export const assertModule = lazyExport<Record<string, unknown>>('assert', 'ok') as unknown as Record<string, unknown>;
export const querystringModule = lazyModule<Record<string, unknown>>('querystring');
export const punycodeModule = lazyModule<Record<string, unknown>>('punycode');
export const constantsModule = lazyModule<Record<string, unknown>>('constants');
export const diagnosticsChannelModule = lazyModule<Record<string, unknown>>('diagnostics_channel');

/** `os`, on a binding of the engine's own host answers. */
export const osModule = lazyModule<Record<string, unknown>>('os');

/** `tty`, on the `tty_wrap` binding `child_process` already brought. */
export const ttyModule = lazyModule<Record<string, unknown>>('tty');

/** `readline`, with Node's own `Interface`, its key handling and its promises. */
export const readlineModule = lazyModule<Record<string, unknown>>('readline');
export const readlinePromisesModule = lazyModule<Record<string, unknown>>('readline/promises');

/** `zlib`, on zlib's own inflate and deflate. */
export const zlibModule = lazyModule<Record<string, unknown>>('zlib');
