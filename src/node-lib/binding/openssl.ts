/**
 * OPENSSL AS THE crypto AND tls_wrap BINDINGS REACH IT (ADR-0018 §1, item 7; ADR-0016 §3). OpenSSL 3.5.8 and ncrypto
 * are in the process's `libnode.so`, and the OpenSSL half of Node's `src/crypto/crypto_*.cc` is the `node` program's
 * glue (`native/node/crypto_*.cc`), whose exports these bindings call through the program
 * (`libnode.ts`): bytes are copied into the process's memory for a call and its answer copied out, as a browser's
 * APIs refuse a view of shared memory. What OpenSSL raises inside a call (a handshake, a key log line, a session, the
 * certificate and ALPN callbacks) reaches the engine as its `tls_*` imports (`libnodeImports`).
 *
 * A realm the host gives no `node` program has no OpenSSL, as a Node built without it: its TLS and its bindings over
 * OpenSSL answer that it has none.
 *
 * The process's OpenSSL is started by the program's `main` before the engine starts (native/node/node_start.cc and
 * crypto_util.cc), as Node's InitializeOncePerProcess and NodeMainInstance start it: its configuration file from
 * `--openssl-config` or OPENSSL_CONF, `--openssl-shared-config`, FIPS, then InitCryptoOnce with
 * `--openssl-legacy-provider` and `--secure-heap`; a configuration error ends the process there, as Node's does.
 */
import { address, libnode, libnodeAttached, type LibnodeExports } from './libnode';

/** The program's exports of `native/node/crypto_*.cc`, by their C names. */
export type OpensslExports = LibnodeExports & { [name: `tabnode_${string}`]: (...args: any[]) => any };

/** The program's OpenSSL exports, started by its `main`. */
export function openssl(): OpensslExports {
  return libnode().exports as OpensslExports;
}

/** A NUL-terminated string at `at` in the process's memory (null for a null pointer). */
export function cString(at: number): string | null {
  return libnode().cString(address(at));
}

/**
 * Runs `use` with `data` copied into the process's memory (and NUL-terminated, for a string), freeing it after.
 * `use` gets the pointer and the byte length.
 */
export function withBytes<T>(data: Uint8Array | string, use: (at: number, length: number) => T): T {
  const program = libnode();
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const room = new Uint8Array(source.byteLength + 1);
  room.set(source);
  const at = address(program.exports.tabnode_malloc(room.byteLength));
  try {
    program.write(at, room);
    return use(at, source.byteLength);
  } finally {
    program.exports.tabnode_free(at);
  }
}

/** Runs `use` with a scratch area of `length` bytes in the process's memory, zeroed, freeing it after. */
export function withScratch<T>(length: number, use: (at: number) => T): T {
  const program = libnode();
  const at = address(program.exports.tabnode_malloc(length));
  try {
    program.write(at, new Uint8Array(length));
    return use(at);
  } finally {
    program.exports.tabnode_free(at);
  }
}

/** The unsigned 32-bit word at `at` (a size_t or a pointer on wasm32). */
export function word(at: number): number {
  const bytes = libnode().read(address(at), 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/** The signed 32-bit word at `at`. */
export function int32(at: number): number {
  return word(at) | 0;
}

/**
 * A malloc'd answer of the glue, `(…, size_t* length) => char*`, copied out and freed: `call` is given the address
 * the length is written to. Null where the answer is null ("undefined" in Node's object).
 */
export function mallocAnswer(call: (lengthAt: number) => number): Uint8Array | null {
  return withScratch(4, (lengthAt) => {
    const at = address(call(lengthAt));
    if (!at) return null;
    const bytes = copyOut(at, word(lengthAt));
    libnode().exports.tabnode_free(at);
    return bytes;
  });
}

/**
 * An out-pointer answer of the glue, `(…, unsigned char** out) => size_t`, copied out and freed when `owned` (memory
 * OpenSSL or the glue allocated with the process's malloc); a borrowed one (a pointer into OpenSSL's own object) is
 * only copied. Null for an empty answer.
 */
export function outAnswer(call: (outAt: number) => number, owned = true): Uint8Array | null {
  return withScratch(4, (outAt) => {
    const length = address(call(outAt));
    const at = word(outAt);
    if (!at) return null;
    const bytes = copyOut(at, length);
    if (owned) libnode().exports.tabnode_free(at);
    return bytes;
  });
}

/** Copies `length` bytes at `at` out of the process's memory. */
export function copyOut(at: number, length: number): Uint8Array {
  return libnode().read(address(at), address(length));
}

/**
 * An OpenSSL error code's `library` and `reason` strings, and the reason as Node writes it into a code, upper-cased
 * with underscores (crypto_util.cc:566-575, crypto_tls.cc:889-897).
 */
export function errorDetail(code: number): { library: string | null; reason: string | null; reasonCode: string | null } {
  const exports = openssl();
  const library = code ? cString(exports.tabnode_err_lib_string(code)) : null;
  const reason = code ? cString(exports.tabnode_err_reason_string(code)) : null;
  return { library, reason, reasonCode: reason === null ? null : reason.toUpperCase().replace(/ /g, '_') };
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
export function opensslError(message: string, code = openssl().tabnode_err_get() >>> 0): Error {
  const exports = openssl();
  const text = code ? withScratch(128, (at) => {
    exports.tabnode_err_string(code, at, 128);
    return cString(at) ?? message;
  }) : message;
  const error = new Error(text) as Error & Record<string, unknown>;
  if (code) {
    const { library, reason, reasonCode } = errorDetail(code);
    if (library) error.library = library;
    if (reason) {
      error.reason = reason;
      const name = ERROR_LIBRARIES[exports.tabnode_err_lib(code)];
      const lib = name ? `${name}_` : '';
      const prefix = lib === 'SSL_' ? '' : 'OSSL_';
      error.code = `ERR_${prefix}${lib}${reasonCode}`;
    }
  }
  exports.tabnode_err_clear();
  return error;
}
