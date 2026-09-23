/**
 * The four small bindings Node's `internal/errors.js`, `internal/validators.js`
 * and `internal/net.js` reach for on their way to `net`.
 *
 * Each is the whole of what those files read from it and nothing more.
 */
import { constantsBinding as buildConstantsBinding } from '../../shims/constants';
import { UV_ENOSYS } from './uv';
import * as osShim from '../../shims/os';
import { nodeLibInternalRequire } from '../load';

/**
 * `internalBinding('constants')`: the engine's own constants module, which
 * already answers Node's `os.signals`, `os.errno` and the rest.
 * `internal/validators.js` reads `constants.os.signals` to validate a signal
 * name.
 *
 * Built on the first property read, not when this file is evaluated. The
 * function that builds the table reads `crypto.constants` through a getter;
 * calling it at module scope is a use of that binding while `crypto.ts` is
 * still in its body (the constants file and the crypto shim import each
 * other through this table), which is `Cannot access 'constants$N' before
 * initialization` in a consumer's Node.
 */
// eslint-disable-next-line no-var, vars-on-top
var __constants: Record<string, unknown> | undefined;
// eslint-disable-next-line no-var, vars-on-top
var __zlibModesApplied = false;

/**
 * Node's `zlib` constant group carries the FLUSH and error values a program
 * reads AND the mode enum its own `zlib.js` switches on -- `DEFLATE` through
 * `ZSTD_DECOMPRESS`, which is how `new Gzip()` tells the binding what it is.
 * The engine's table had the first half only, so `zlib.js` asserted on its
 * own mode before it made a handle. The modes are added here, beside the
 * group they belong to, in the order Node's own enum has them.
 */
const __zlibModes = {
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
  BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_COMPRESS: 10, ZSTD_DECOMPRESS: 11,
};

function constantsOf(): Record<string, unknown> {
  return __constants ??= buildConstantsBinding() as unknown as Record<string, unknown>;
}

function applyZlibModes(): void {
  if (__zlibModesApplied) return;
  __zlibModesApplied = true;
  const table = constantsOf();
  const zlib = table.zlib as Record<string, unknown> | undefined;
  if (zlib) Object.assign(zlib, __zlibModes);
  else table.zlib = { ...__zlibModes };
}

export const constantsBinding = new Proxy({} as Record<string, unknown>, {
  get: (_t, key, receiver) => {
    if (key === 'zlib') applyZlibModes();
    return Reflect.get(constantsOf(), key, receiver);
  },
  set: (_t, key, value, receiver) => Reflect.set(constantsOf(), key, value, receiver),
  has: (_t, key) => Reflect.has(constantsOf(), key),
  ownKeys: () => Reflect.ownKeys(constantsOf()),
  getOwnPropertyDescriptor: (_t, key) => {
    if (key === 'zlib') applyZlibModes();
    const descriptor = Reflect.getOwnPropertyDescriptor(constantsOf(), key);
    return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
  },
  defineProperty: (_t, key, descriptor) => Reflect.defineProperty(constantsOf(), key, descriptor),
});

/**
 * `internalBinding('os')`: `internal/errors.js` names the host in the banner
 * it prints for an uncaught exception under a report flag the engine never
 * sets, which is the only call.
 */
// eslint-disable-next-line no-var, vars-on-top
var __priorities = new Map<number, number>();

export const osBinding = {
  /** Node's `os.type()`, `release()` and `version()`, in that order. */
  getOSInformation: (): string[] => [osShim.type(), osShim.release(), osShim.version()],
  getHostname: (): string => osShim.hostname(),
  /**
   * Node's `os.homedir()` is libuv's: `HOME` when the environment sets it,
   * the account's directory otherwise. `userInfo().homedir` stays the
   * account's, as it is in Node.
   */
  getHomeDirectory: (): string => {
    const home = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HOME;
    return home && home.length > 0 ? home : osShim.homedir();
  },
  getUptime: (): number => osShim.uptime(),
  getTotalMem: (): number => osShim.totalmem(),
  getFreeMem: (): number => osShim.freemem(),
  getLoadAvg: (array: Float64Array): void => {
    const [one, five, fifteen] = osShim.loadavg();
    array[0] = one; array[1] = five; array[2] = fifteen;
  },
  getAvailableParallelism: (): number => (osShim as { availableParallelism?: () => number }).availableParallelism?.() ?? osShim.cpus().length,
  isBigEndian: osShim.endianness() === 'BE',
  /**
   * Node reads its CPU list as a flat array: a model and a speed, then the
   * five time counters, for each core.
   */
  getCPUs: (): Array<string | number> => {
    const flat: Array<string | number> = [];
    for (const cpu of osShim.cpus()) {
      flat.push(cpu.model, cpu.speed, cpu.times.user, cpu.times.nice, cpu.times.sys, cpu.times.idle, cpu.times.irq);
    }
    return flat;
  },
  /**
   * The same shape for interfaces: name, address, netmask, family, mac,
   * scope id, then the CIDR, per address.
   */
  getInterfaceAddresses: (): Array<string | number | boolean> => {
    const flat: Array<string | number | boolean> = [];
    for (const [name, addresses] of Object.entries(osShim.networkInterfaces())) {
      for (const address of addresses ?? []) {
        flat.push(name, address.address, address.netmask, address.family === 'IPv6' ? 6 : 4,
          address.mac, address.internal, (address as { scopeid?: number }).scopeid ?? 0);
      }
    }
    return flat;
  },
  getUserInfo: (): Record<string, unknown> => osShim.userInfo() as unknown as Record<string, unknown>,
  /**
   * A process's niceness. A tab has no scheduler to hand it to, but the pair
   * still has to agree: a program that sets a priority and reads it back must
   * see what it set, which is what `test-os.js` checks. The value is this
   * engine's, per pid, and changes nothing about how anything runs.
   */
  getPriority: (pid: number): number => __priorities.get(pid || 0) ?? osShim.getPriority(pid),
  setPriority: (pid: number, priority: number): number => {
    __priorities.set(pid || 0, priority);
    osShim.setPriority(pid, priority);
    return 0;
  },
};

/**
 * `internalBinding('credentials')`: the one name `os.js` takes from it. A tab
 * has no environment of its own to read `TMPDIR` from, so the answer is the
 * directory the engine's `os` calls its temporary one.
 */
export const credentialsBinding = {
  /**
   * Where a temporary file goes. Node reads `TMPDIR`, then `TMP`, then
   * `TEMP` from the environment and falls back to the platform's directory,
   * dropping a trailing slash; a program that sets `TMPDIR` expects to be
   * obeyed, which is what `test-os.js` checks.
   */
  getTempDir: (): string => {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const named = env.TMPDIR || env.TMP || env.TEMP;
    const chosen = named && named.length > 0 ? named : osShim.tmpdir();
    return chosen.length > 1 && chosen.endsWith('/') ? chosen.slice(0, -1) : chosen;
  },
};

/**
 * `internalBinding('encoding_binding')`: the punycode conversion `url.js`
 * makes for a host name, out of the engine's own `punycode`.
 */
export const encodingBinding = {
  toASCII: (value: string): string => (nodeLibInternalRequire('punycode') as { toASCII(value: string): string }).toASCII(value),
  toUnicode: (value: string): string => (nodeLibInternalRequire('punycode') as { toUnicode(value: string): string }).toUnicode(value),
};

/**
 * `internalBinding('config')`: the build switches Node's own files read. The
 * engine has no ICU, so `buffer.transcode` is not defined -- which is what
 * Node without ICU does, and is the one thing `buffer.js` loses here.
 */
export const configBinding = {
  // No ICU: Node navigator supplies its own default for an empty locale.
  getDefaultLocale: (): string => '',
  hasIntl: false,
  hasSmallICU: false,
  hasNodeOptions: true,
  hasInspector: false,
  noBrowserGlobals: false,
  bits: 64,
  hasOpenSSL: false,
  fipsMode: false,
  hasDtrace: false,
};

/**
 * `internalBinding('fs')`: `internal/net.js`'s `makeSyncWrite` writes a
 * descriptor synchronously, which Node does only for Windows' stdout and
 * stderr. The engine's platform is `linux` and nothing reaches it.
 */
export const fsBinding = {
  writeBuffer: (_fd: number, _buffer: Uint8Array, _offset: number, _length: number,
    _position: unknown, _req: unknown, ctx: { errno?: number; syscall?: string }): number => {
    ctx.errno = UV_ENOSYS;
    ctx.syscall = 'write';
    return 0;
  },
};


/**
 * `internalBinding('types')`: V8's own type tests. The engine answers them
 * out of the realm's built-ins, and `internal/util/types` is the same object
 * -- Node's own `util.types` is that binding with a doc comment on it.
 */
export { internalUtilTypes as typesBinding } from '../internals/util';

/**
 * `internalBinding('string_decoder')`: `internal/util.js` reads the table of
 * encoding names out of it to normalize one.
 */
export const stringDecoderBinding = {
  encodings: ['ascii', 'utf8', 'base64', 'ucs2', 'binary', 'hex', 'utf16le', 'base64url'],
};

/**
 * `internalBinding('trace_events')`: the tracing category buffer
 * `internal/util/debuglog.js` reads to decide whether a section is traced.
 * Nothing in a tab is traced, so every category reads 0 -- which is what
 * `debuglog` checks before it formats anything.
 */
export const traceEventsBinding = {
  getCategoryEnabledBuffer: (): Uint8Array => new Uint8Array(1),
  trace: (): void => {},
};

/**
 * `internalBinding('messaging')`: `internal/util.js` reaches for
 * `DOMException` through it, which the realm already has.
 */
export const messagingBinding = {
  get DOMException() { return (globalThis as { DOMException?: unknown }).DOMException; },
};


/**
 * `internalBinding('errors')`: the one call `diagnostics_channel.js` makes
 * into it. A subscriber that throws must not be swallowed and must not take
 * the publisher with it, so Node hands the error to the process as an
 * uncaught exception. The engine has that door already -- it is how a run
 * reports a throw nobody caught -- and this reaches it through the realm's
 * own process, which is the run's.
 */
export const errorsBinding = {
  triggerUncaughtException: (error: unknown, fromPromise = false): void => {
    const realm = (globalThis as {
      process?: { emit?: (event: string, ...args: unknown[]) => boolean; listenerCount?: (event: string) => number };
    }).process;
    const event = fromPromise ? 'unhandledRejection' : 'uncaughtException';
    if (realm && typeof realm.listenerCount === 'function' && realm.listenerCount(event) > 0) {
      realm.emit?.(event, error, event);
      return;
    }
    // Nobody is listening: the throw becomes this realm's, on the next turn,
    // rather than the publisher's to catch.
    setTimeout(() => { throw error; }, 0);
  },
};
