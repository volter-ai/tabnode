/**
 * node-deps.wasm, Node's own C libraries as one module (ADR-0016): compiled on the realm's first use and
 * instantiated once for the realm, which every `SecureContext` and `TLSWrap` of the realm then lives in. Its memory
 * is its own and not shared; bytes cross by copy, and no `Buffer` is ever placed in it (ADR-0016 §2).
 *
 * Its imports are WASI's and the engine's TLS callbacks (`tabnode`). The callbacks are bound by the `tls_wrap`
 * binding through `setTlsCallbacks`; until it does, a callback is a no-op that lets the handshake continue.
 */
import { NODE_DEPS_WASM_BASE64 } from './node-deps-wasm';

/** The module's exports (scripts/node-deps/tabnode_deps.cc). Pointers and sizes are wasm32 numbers. */
export interface NodeDepsExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  [name: `tn_${string}`]: (...args: any[]) => any;
}

/** The engine's side of the module's `tabnode` imports (tabnode_deps.cc, "The engine's callbacks"). */
export interface TlsCallbacks {
  handshake(ssl: number, done: number): void;
  keylog(ssl: number, line: Uint8Array): void;
  newSession(ssl: number, id: Uint8Array, der: Uint8Array): void;
  /** Answers 1 to continue the handshake, -1 to suspend it until `certCbDone`. */
  cert(ssl: number, servername: string, ocsp: boolean): number;
  /** Answers the offset of the chosen protocol in `protocols`, or -1 (undefined: a fatal alert). */
  alpn(ssl: number, protocols: Uint8Array): number;
}

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_EINVAL = 28;
const WASI_ENOSYS = 52;

let callbacks: TlsCallbacks | undefined;
let compiled: WebAssembly.Module | undefined;
let instance: NodeDepsExports | undefined;

export function setTlsCallbacks(next: TlsCallbacks): void {
  callbacks = next;
}

class NodeDepsExit extends Error {
  constructor(code: number) {
    super(`node-deps.wasm called exit(${code}); Node's own OpenSSL aborted`);
    this.name = 'NodeDepsExit';
  }
}

/** The realm's instance, made on the first ask. */
export function nodeDeps(): NodeDepsExports {
  if (instance) return instance;
  compiled ??= new WebAssembly.Module(Uint8Array.from(atob(NODE_DEPS_WASM_BASE64), (c) => c.charCodeAt(0)));
  let exports: NodeDepsExports | undefined;
  const view = () => new DataView(exports!.memory.buffer);
  const bytes = (at: number, length: number) => new Uint8Array(exports!.memory.buffer, at >>> 0, length >>> 0);
  const enosys = () => WASI_ENOSYS;
  const wasi = {
    // The engine's one randomness source and clock, taken as they are (ADR-0016 §2): the same
    // `crypto.getRandomValues` the `crypto` module's randomness calls, `Date.now()` for the realtime clock
    // OpenSSL checks a certificate's validity against, and `performance.now()` for the monotonic one.
    random_get(at: number, length: number) {
      for (let offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(bytes(at + offset, Math.min(65536, length - offset)));
      }
      return WASI_ESUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, at: number) {
      let ns: bigint;
      if (id === 0) ns = BigInt(Date.now()) * 1_000_000n;
      else if (id === 1) ns = BigInt(Math.round(performance.now() * 1e6));
      else return WASI_EINVAL;
      view().setBigUint64(at >>> 0, ns, true);
      return WASI_ESUCCESS;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count >>> 0, 0, true);
      view().setUint32(size >>> 0, 0, true);
      return WASI_ESUCCESS;
    },
    environ_get: () => WASI_ESUCCESS,
    // No descriptor is preopened and none is open: the module reads no files (ADR-0016 §1).
    fd_prestat_get: () => WASI_EBADF,
    fd_prestat_dir_name: () => WASI_EBADF,
    fd_close: () => WASI_EBADF,
    fd_fdstat_get: () => WASI_EBADF,
    fd_fdstat_set_flags: () => WASI_EBADF,
    fd_filestat_get: () => WASI_EBADF,
    fd_read: () => WASI_EBADF,
    fd_readdir: () => WASI_EBADF,
    fd_seek: () => WASI_EBADF,
    fd_write: enosys,
    path_filestat_get: enosys,
    path_open: enosys,
    proc_exit(code: number) {
      throw new NodeDepsExit(code);
    },
  };
  const string = (at: number, length: number) => new TextDecoder().decode(bytes(at, length));
  const tabnode = {
    handshake: (ssl: number, done: number) => callbacks?.handshake(ssl >>> 0, done),
    keylog: (ssl: number, at: number, length: number) => callbacks?.keylog(ssl >>> 0, bytes(at, length).slice()),
    new_session: (ssl: number, id: number, idLength: number, der: number, derLength: number) => {
      callbacks?.newSession(ssl >>> 0, bytes(id, idLength).slice(), bytes(der, derLength).slice());
      return 0;
    },
    cert: (ssl: number, at: number, length: number, ocsp: number) =>
      callbacks ? callbacks.cert(ssl >>> 0, string(at, length), ocsp !== 0) : 1,
    alpn: (ssl: number, at: number, length: number) =>
      callbacks ? callbacks.alpn(ssl >>> 0, bytes(at, length).slice()) : -1,
  };
  const made = new WebAssembly.Instance(compiled, { wasi_snapshot_preview1: wasi, tabnode });
  exports = made.exports as unknown as NodeDepsExports;
  exports._initialize();
  return instance = exports;
}

/** A NUL-terminated string at `at` in the module's memory (null for a null pointer). */
export function cString(at: number): string | null {
  if (!at) return null;
  const memory = new Uint8Array(nodeDeps().memory.buffer);
  let end = at >>> 0;
  while (memory[end] !== 0) end++;
  return new TextDecoder().decode(memory.subarray(at >>> 0, end));
}

/**
 * Runs `use` with `data` copied into the module's memory (and NUL-terminated, for a string), freeing it after.
 * `use` gets the pointer and the byte length.
 */
export function withBytes<T>(data: Uint8Array | string, use: (at: number, length: number) => T): T {
  const deps = nodeDeps();
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const at = deps.tn_malloc(source.byteLength + 1) >>> 0;
  try {
    const target = new Uint8Array(deps.memory.buffer, at, source.byteLength + 1);
    target.set(source);
    target[source.byteLength] = 0;
    return use(at, source.byteLength);
  } finally {
    deps.tn_free(at);
  }
}

/** Runs `use` with a scratch area of `length` bytes in the module's memory, freeing it after. */
export function withScratch<T>(length: number, use: (at: number) => T): T {
  const deps = nodeDeps();
  const at = deps.tn_malloc(length) >>> 0;
  try {
    return use(at);
  } finally {
    deps.tn_free(at);
  }
}

/** Copies `length` bytes at `at` out of the module's memory. */
export function copyOut(at: number, length: number): Uint8Array {
  return new Uint8Array(nodeDeps().memory.buffer, at >>> 0, length >>> 0).slice();
}

/** The libraries `error::Decorate` names (crypto_util.cc:583-627, OSSL_ERROR_CODES_MAP), by `ERR_LIB_*` number. */
const ERROR_LIBRARIES: Record<number, string> = {
  2: 'SYS', 3: 'BN', 4: 'RSA', 5: 'DH', 6: 'EVP', 7: 'BUF', 8: 'OBJ', 9: 'PEM', 10: 'DSA', 11: 'X509', 13: 'ASN1',
  14: 'CONF', 15: 'CRYPTO', 16: 'EC', 20: 'SSL', 32: 'BIO', 33: 'PKCS7', 34: 'X509V3', 35: 'PKCS12', 36: 'RAND',
  37: 'DSO', 38: 'ENGINE', 39: 'OCSP', 40: 'UI', 41: 'COMP', 42: 'ECDSA', 43: 'ECDH', 44: 'OSSL_STORE', 45: 'FIPS',
  46: 'CMS', 47: 'TS', 48: 'HMAC', 50: 'CT', 51: 'ASYNC', 52: 'KDF', 53: 'SM2', 128: 'USER',
};

/**
 * Node's `ThrowCryptoError` (crypto_util.cc:653-677) and `error::Decorate` (535-650) for `code`, by default the
 * head of OpenSSL's queue: the message is `ERR_error_string_n`'s where there is a code, else `message`; `library`,
 * `reason` and `code` (`ERR_` + `OSSL_` unless the library is SSL + the library's name + the reason upper-cased,
 * spaces to underscores) are set as Node sets them. The queue is cleared.
 */
export function opensslError(message: string, code = nodeDeps().tn_err_get() >>> 0): Error {
  const deps = nodeDeps();
  const text = code ? withScratch(128, (at) => {
    deps.tn_err_string(code, at, 128);
    return cString(at) ?? message;
  }) : message;
  const error = new Error(text) as Error & Record<string, unknown>;
  if (code) {
    const library = cString(deps.tn_err_lib_string(code));
    const reason = cString(deps.tn_err_reason_string(code));
    if (library) error.library = library;
    if (reason) {
      error.reason = reason;
      const name = ERROR_LIBRARIES[deps.tn_err_lib(code)];
      const lib = name ? `${name}_` : '';
      const prefix = lib === 'SSL_' ? '' : 'OSSL_';
      error.code = `ERR_${prefix}${lib}${reason.toUpperCase().replace(/ /g, '_')}`;
    }
  }
  deps.tn_err_clear();
  return error;
}

let cryptoConstants: Record<string, number | string> | undefined;
/**
 * Node's crypto constants (node_constants.cc `DefineCryptoConstants`), the body compiled as Node writes it against
 * the built OpenSSL (tabnode_deps.cc `tn_crypto_constants`). The same object every time, as Node's binding is.
 */
export function nodeCryptoConstants(): Record<string, number | string> {
  if (cryptoConstants) return cryptoConstants;
  const deps = nodeDeps();
  const text = withScratch(4, (lengthAt) => {
    const at = deps.tn_crypto_constants(lengthAt) >>> 0;
    const length = new DataView(deps.memory.buffer).getUint32(lengthAt, true);
    const value = new TextDecoder().decode(new Uint8Array(deps.memory.buffer, at, length));
    deps.tn_free(at);
    return value;
  });
  const table: Record<string, number | string> = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const kind = line[0];
    const space = line.indexOf(' ', 2);
    const name = line.slice(2, space);
    const value = line.slice(space + 1);
    table[name] = kind === 'n' ? Number(value) : value;
  }
  return cryptoConstants = table;
}
