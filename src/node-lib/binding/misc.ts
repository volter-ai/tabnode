import { processHostnameOf } from '../../process-hostname';
import { processCredentialsOf } from '../../process-credentials';
/**
 * The four small bindings Node's `internal/errors.js`, `internal/validators.js`
 * and `internal/net.js` reach for on their way to `net`.
 *
 * Each is the whole of what those files read from it and nothing more.
 */
import { constantsBinding as buildConstantsBinding } from '../../shims/constants';
import { uvConstant } from './uv';
import { performance as systemPerformance } from '../../system';
import * as osShim from '../../shims/os';
import { treeSocketsOf, type TreeSockets } from '../../host-sockets';
import { nodeLibInternalRequire } from '../load';
import { setTimeout } from '../../engine-timers';
import { adaToAscii } from './ada_idna';
import { hostnameToUnicode } from '../internals/url';

/**
 * `internalBinding('constants')` (`src/shims/constants.ts`): the program's compiled constants where the realm has the
 * `node` program, the engine's tables where it has none. Built on the first property read, not when this file is
 * evaluated: the realm's program is attached by then, and the table is the program's.
 */
// eslint-disable-next-line no-var, vars-on-top
var __constants: Record<string, unknown> | undefined;
function constantsOf(): Record<string, unknown> {
  return __constants ??= buildConstantsBinding() as unknown as Record<string, unknown>;
}

export const constantsBinding = new Proxy({} as Record<string, unknown>, {
  get: (_t, key, receiver) => Reflect.get(constantsOf(), key, receiver),
  set: (_t, key, value, receiver) => Reflect.set(constantsOf(), key, value, receiver),
  has: (_t, key) => Reflect.has(constantsOf(), key),
  ownKeys: () => Reflect.ownKeys(constantsOf()),
  getOwnPropertyDescriptor: (_t, key) => {
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
  // The order lib/os.js reads: sysname, version, release, machine (`const { 0: type, 1: version, 2: release,
  // 3: machine } = getOSInformation()`). Handed type, release, version, a guest's os.release() was the version
  // string, os.version() the release, and os.machine() undefined.
  getOSInformation: (): string[] => [osShim.type(), osShim.version(), osShim.release(), osShim.machine()],
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
  getInterfaceAddresses: (sockets?: TreeSockets): Array<string | number | boolean> => {
    const flat: Array<string | number | boolean> = [];
    for (const [name, addresses] of Object.entries(osShim.networkInterfaces(sockets))) {
      for (const address of addresses ?? []) {
        // lib/os.js reads the family as its name ('IPv4', 'IPv6') and a scope id of -1 as "none": handed 4 and 0,
        // every interface read `family: 4, scopeid: 0`, and a program asking for `family === 'IPv4'` found none.
        flat.push(name, address.address, address.netmask, address.family === 'IPv6' ? 'IPv6' : 'IPv4',
          address.mac, address.internal, address.family === 'IPv6' ? (address as { scopeid?: number }).scopeid ?? 0 : -1);
      }
    }
    return flat;
  },
  // In the order Node's own object has its keys.
  getUserInfo: (): Record<string, unknown> => { const user = osShim.userInfo(); return { uid: user.uid, gid: user.gid, username: user.username, homedir: user.homedir, shell: user.shell }; },
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

/** libuv's account lookup belongs to the asking process, even when multiple guests share this realm. */
export function createOsBinding(process: object): typeof osBinding {
  const credentials = processCredentialsOf(process);
  // The interfaces are the process's kernel's: its tree's socket calls (ADR-0009).
  const sockets = (): TreeSockets | undefined => treeSocketsOf((process as Record<symbol, unknown>)[Symbol.for('tabnode.run.vfs')]);
  return { ...osBinding, getHostname: () => processHostnameOf(process), getUserInfo: () => ({ ...osShim.userInfo(credentials) }),
    getInterfaceAddresses: () => osBinding.getInterfaceAddresses(sockets()) };
}

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
 * `internalBinding('encoding_binding')`: the IDNA conversion `url.js` makes of
 * every host name. `toASCII` is Ada's own `ada::idna::to_ascii`, as Node's
 * (encoding_binding.cc:221-232); `toUnicode` is out of the engine's `punycode`.
 */
export const encodingBinding = {
  toASCII: (value: string): string => adaToAscii(value),
  toUnicode: (value: string): string => (nodeLibInternalRequire('punycode') as { toUnicode(value: string): string }).toUnicode(value),
  /**
   * DecodeUTF8 (src/encoding_binding.cc): a buffer source's bytes as UTF-8, its BOM kept where `ignoreBOM`, and
   * ERR_ENCODING_INVALID_ENCODED_DATA where `fatal` and the bytes are not UTF-8.
   */
  decodeUTF8: (buffer: ArrayBuffer | ArrayBufferView, ignoreBOM?: boolean, fatal?: boolean): string => {
    const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { ignoreBOM: ignoreBOM === true, fatal: fatal === true }).decode(bytes);
    } catch {
      throw Object.assign(new TypeError('The encoded data was not valid for encoding utf-8'),
        { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
    }
  },
  /** EncodeUtf8String (src/encoding_binding.cc): a string's UTF-8 as a Uint8Array. */
  encodeUtf8String: (value: string): Uint8Array => new TextEncoder().encode(value),
};

/**
 * `internalBinding('url')`: the one call the legacy `url.format` makes of it
 * for a WHATWG `URL` (`url.format(url, options)`, url.js:615), node_url.cc
 * `Format` (370-419): the href re-parsed, its fragment, query and credentials
 * dropped as asked, and with `unicode` its host as `ada::idna::to_unicode`
 * gives it. Ada's parser is the realm's `URL` here; an href it cannot parse
 * is answered as it is, as Ada's is. The host is written into the
 * serialization, not set, since the setter would encode it again.
 */
export const urlBinding = {
  format(href: string, hash: boolean, unicode: boolean, search: boolean, auth: boolean): string {
    let url: URL;
    try { url = new URL(href); } catch { return href; }
    if (!hash) url.hash = '';
    if (!search) url.search = '';
    if (!auth) { url.username = ''; url.password = ''; }
    const serialized = url.href;
    if (!unicode || url.hostname === '') return serialized;
    // The host in the serialization, replaced where it stands: an empty query or fragment (`?`, `#`), which the
    // URL's getters read as '', stays as Ada's get_href writes it.
    const credentials = url.username || url.password
      ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
    const before = `${url.protocol}//${credentials}`;
    if (!serialized.startsWith(before + url.hostname)) return serialized;
    return before + hostnameToUnicode(url.hostname) + serialized.slice(before.length + url.hostname.length);
  },
};

/** `internalBinding('url_pattern')`: Node's is Ada's `url_pattern`; the realm's own `URLPattern` stands in. */
export const urlPatternBinding = {
  get URLPattern() { return (globalThis as { URLPattern?: unknown }).URLPattern; },
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
    ctx.errno = uvConstant('UV_ENOSYS');
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
 * `internalBinding('performance')` as `internal/perf/utils.js` reads it (src/node_perf.cc, node_perf_common.h): `now`,
 * the process's monotonic clock in milliseconds from its origin (system.ts `performance`, perf_hooks' own clock), and
 * the time origin's milestones, `TIME_ORIGIN_TIMESTAMP` in microseconds since the epoch and `TIME_ORIGIN` the clock's
 * origin in its own nanoseconds, 0.
 */
export const performanceBinding = {
  constants: { NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 0, NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 1 },
  get milestones(): Float64Array { return Float64Array.of(systemPerformance.timeOrigin * 1e3, 0); },
  now: (): number => systemPerformance.now(),
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
  getErrorSourcePositions(): never {
    throw Object.assign(new Error('Source positions require a compiled guest process.'),
      { code: 'ERR_UNSUPPORTED_OPERATION', capability: 'errors.source-position' });
  },
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
