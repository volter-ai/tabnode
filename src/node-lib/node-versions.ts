/**
 * What this engine reports as its Node, in one place.
 *
 * Two readers need the same answer and neither may import the other: a guest's
 * `process`, built in `src/shims/process.ts` per run, and the process a
 * vendored file is handed where the realm has none, built in
 * `src/node-lib/load.ts` (`shims/process.ts` imports `node-lib/events-module`,
 * so the loader cannot import it back). This file imports only the program's
 * door (`binding/libnode`, which imports nothing of the engine's), so both can.
 */
import { libnode, libnodeAttached } from './binding/libnode';

/** The version a guest reports where its image names none; the vendored compatibility version. */
export const NODE_LTS_VERSION = "24.21.0";

/**
 * `process.versions`, as this engine answers it: Node's own keys, and no key
 * Node does not report. The engine runs over Linux's own calls, sockets
 * among them, so a program that reads a runtime's name from this table reads
 * Node's.
 */
export function nodeVersions(node: string = NODE_LTS_VERSION): {
  node: string;
  v8: string;
  uv: string;
  readonly openssl: string | undefined;
  readonly zlib: string | undefined;
  readonly brotli: string | undefined;
  readonly zstd: string | undefined;
  readonly llhttp: string | undefined;
  amaro: string;
} {
  // `https.js` calls `assertCrypto()`, which is `!process.versions.openssl`.
  // `openssl` names the OpenSSL that runs, read when it is first read: the
  // OpenSSL in the process's libnode.so (ADR-0018 item 7), as Node's
  // GetOpenSSLVersion reads it (node_metadata.cc:57-78), and none in a realm
  // the host gives no `node` program, which has no OpenSSL. A worker compiles
  // `internal/util` against this table before any guest process exists, so
  // the name has to live here. `amaro` is the type stripper a `.ts` file runs
  // through, the release Node v24.21.0 carries; `internal/util` reads it for
  // `assertTypeScript()`.
  return {
    node, v8: "11.3.244.8", uv: "1.44.2",
    get openssl() {
      // Kept once the program is attached; before, and in a realm with none, it answers none each time it is read.
      const value = opensslVersion();
      if (value !== undefined) Object.defineProperty(this, "openssl", { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
    // zlib, brotli, zstd and llhttp are libnode.so's (ADR-0018 item 10), read as Node's Metadata::Versions reads them
    // (node_metadata.cc:104-133), and kept as `openssl` is.
    get zlib() { return kept(this, "zlib", libraryVersions()?.zlib); },
    get brotli() { return kept(this, "brotli", libraryVersions()?.brotli); },
    get zstd() { return kept(this, "zstd", libraryVersions()?.zstd); },
    get llhttp() { return kept(this, "llhttp", libraryVersions()?.llhttp); },
    amaro: "1.1.11",
  };
}

/** `value` kept on `target` once there is one, as `openssl` keeps its. */
function kept(target: object, name: string, value: string | undefined): string | undefined {
  if (value !== undefined) Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
  return value;
}

/**
 * The program's zlib, brotli, zstd and llhttp versions (native/node node_zlib.c and node_http_parser.c): ZLIB_VERSION,
 * BrotliEncoderVersion() as MAJOR.MINOR.PATCH, ZSTD_VERSION_STRING and LLHTTP_VERSION_*; none in a realm with no program.
 */
function libraryVersions(): { zlib: string; brotli: string; zstd: string; llhttp: string } | undefined {
  if (!libnodeAttached()) return undefined;
  const program = libnode();
  const exports = program.exports as unknown as {
    tabnode_zlib_version(): number; tabnode_brotli_version(): number; tabnode_zstd_version(): number; tabnode_llhttp_version(): number;
  };
  const brotli = exports.tabnode_brotli_version() >>> 0;
  return {
    zlib: program.cString(exports.tabnode_zlib_version()) ?? "",
    brotli: `${brotli >>> 24}.${(brotli & 0xfff000) >>> 12}.${brotli & 0xfff}`,
    zstd: program.cString(exports.tabnode_zstd_version()) ?? "",
    llhttp: program.cString(exports.tabnode_llhttp_version()) ?? "",
  };
}

/**
 * GetOpenSSLVersion (node_metadata.cc:57-78): the second word of `OpenSSL_version(OPENSSL_VERSION)` ("0.0.0" where
 * it has none), from the program's `tabnode_openssl_version` (native/node/crypto_util.cc).
 */
function opensslVersion(): string | undefined {
  if (!libnodeAttached()) return undefined;
  const program = libnode();
  const exports = program.exports as unknown as { tabnode_openssl_version(): number };
  const version = program.cString(exports.tabnode_openssl_version()) ?? "";
  const words = version.split(" ");
  return words.length < 2 ? "0.0.0" : words[1];
}

/**
 * `process.release`, in Node's shape (v24.21.0: name, lts, sourceUrl, headersUrl). The two addresses follow the
 * version by Node's fixed scheme. `lts` is the release line's code name, known here for the library's own version
 * only; for a version an image names it is left out rather than guessed.
 */
export function nodeRelease(node: string = NODE_LTS_VERSION): { name: string; lts?: string; sourceUrl: string; headersUrl: string } {
  const base = `https://nodejs.org/download/release/v${node}/node-v${node}`;
  return { name: "node", ...(node === NODE_LTS_VERSION ? { lts: "Krypton" } : {}), sourceUrl: `${base}.tar.gz`, headersUrl: `${base}-headers.tar.gz` };
}

/*
 * Keys of Node's `process.versions` this engine does not answer, because it carries no such thing or another
 * thing in its place, and a version of what is not there would be a lie: ada, ares, cldr, icu, merve, modules and
 * napi (no native addon loads), nbytes, ncrypto, nghttp2, nghttp3, ngtcp2, simdjson, simdutf, sqlite, tz, undici,
 * unicode, uvwasi. `acorn` is answered where the process object is made, from the parser's own version.
 */
