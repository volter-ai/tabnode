/**
 * `util`, as Node's own `lib/util.js`.
 *
 * What died: the engine's `util` was hand-written, 632 lines, and its
 * `inspect` was a recursive `JSON`-ish printer. Node's own `test-util-*`: 3
 * of 27 passed. `inspect` is not a convenience -- it is what `console.log`
 * prints, what an `AssertionError` shows, what a thrown object reads as in a
 * stack, and what every one of Node's own tests compares against. A
 * hand-written one disagrees with Node in the exact places a person is
 * reading output to find out what went wrong.
 *
 * What this is: Node's `lib/util.js` and `lib/internal/util/inspect.js`
 * v22.18.0, vendored unmodified, with `internal/util`, `internal/util/
 * comparisons`, `internal/util/debuglog` and `internal/util/colors` beside
 * them. `format`, `inspect`, `promisify`, `callbackify`, `deprecate`,
 * `isDeepStrictEqual`, `parseArgs`, `styleText` and the rest are Node's own
 * code.
 *
 * THE ONE NAMED LOSS: `internalBinding('util')`'s `getProxyDetails` and
 * `getPromiseDetails` are V8 introspection, and no JavaScript in a tab can
 * answer them -- a `Proxy` is invisible to the code it wraps by design, and a
 * promise's state cannot be read without awaiting it. So `inspect` prints a
 * proxy as the object it stands for (which is what Node prints without
 * `--show-proxy`) and a promise as `Promise { <pending> }` whatever it has
 * settled to. Everything else the binding is asked for -- an object's
 * non-index properties, a constructor's name, a Map's or a Set's entries --
 * the engine answers for real.
 *
 * The rule for this file: it binds, it does not implement.
 */
import { lazyModule, lazyExport } from './lazy';

/** What `util.inspect` takes. */
export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  showHidden?: boolean;
  customInspect?: boolean;
  showProxy?: boolean;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  breakLength?: number;
  compact?: boolean | number;
  sorted?: boolean | ((a: string, b: string) => number);
  getters?: boolean | 'get' | 'set';
  numericSeparator?: boolean;
}

/** The whole of Node's `util` module object. */
export interface UtilModule {
  format(...args: unknown[]): string;
  formatWithOptions(options: InspectOptions, ...args: unknown[]): string;
  inspect: ((value: unknown, options?: InspectOptions) => string) & {
    custom: symbol;
    colors: Record<string, [number, number]>;
    styles: Record<string, string>;
    defaultOptions: InspectOptions;
  };
  promisify: ((fn: (...args: never[]) => void) => (...args: never[]) => Promise<unknown>) & { custom: symbol };
  callbackify(fn: (...args: never[]) => Promise<unknown>): (...args: never[]) => void;
  deprecate<T>(fn: T, message: string, code?: string): T;
  debuglog(section: string, callback?: (fn: (...args: unknown[]) => void) => void): (...args: unknown[]) => void;
  debug: UtilModule['debuglog'];
  isDeepStrictEqual(a: unknown, b: unknown): boolean;
  parseArgs(config?: unknown): unknown;
  parseEnv(content: string): Record<string, string>;
  stripVTControlCharacters(value: string): string;
  styleText(format: string | string[], text: string, options?: unknown): string;
  toUSVString(value: string): string;
  transferableAbortController(): AbortController;
  transferableAbortSignal(signal: AbortSignal): AbortSignal;
  aborted(signal: AbortSignal, resource: object): Promise<void>;
  getSystemErrorName(errno: number): string;
  getSystemErrorMap(): Map<number, [string, string]>;
  getCallSites?: (frames?: number) => unknown[];
  types: Record<string, (value: unknown) => boolean>;
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
  MIMEType: unknown;
  MIMEParams: unknown;
  /** Node's deprecated type tests, still exported and still read by old packages. */
  isArray(value: unknown): boolean;
  isDate(value: unknown): boolean;
  isError(value: unknown): boolean;
  isFunction(value: unknown): boolean;
  isNullOrUndefined(value: unknown): boolean;
  isNumber(value: unknown): boolean;
  isObject(value: unknown): boolean;
  isPrimitive(value: unknown): boolean;
  isRegExp(value: unknown): boolean;
  isString(value: unknown): boolean;
  isUndefined(value: unknown): boolean;
  _extend(target: object, source: object): object;
  inherits(constructor: unknown, superConstructor: unknown): void;
}

/** Node's own `util.js`, built by the loader on the first property read. */
export const utilModule = lazyModule<UtilModule>('util');

/** The two names the engine's own parts reach for directly. */
export const inspect = lazyExport<UtilModule['inspect']>('util', 'inspect');
export const format = lazyExport<UtilModule['format']>('util', 'format');

export default utilModule;
