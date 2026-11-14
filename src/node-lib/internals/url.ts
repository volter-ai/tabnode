/**
 * `internal/url`, bound by hand: the names Node's own `url.js`, `internal/modules/customization_hooks.js`,
 * `_http_client.js`, `https.js` and `fs.js` take from it.
 *
 * Node's `lib/internal/url.js` is its WHATWG `URL` over Ada's `url_aggregator` (`internalBinding('url')`); Ada is
 * built here only for IDNA (`../binding/ada_idna.ts`), so the `URL` this answers is the realm's own, a process's with
 * Node's `createObjectURL` and `revokeObjectURL` (`../object-urls.ts`). Every other name is Node's function
 * transcribed over that `URL`, with Node's own errors from the vendored `internal/errors`.
 */
import { errorCodes } from '../binding/crypto';
import { processUrl } from '../object-urls';
import { nodeLibInternalRequire } from '../load';

type Require = (name: string) => any;

/** Protocols that can allow "unsafe" and "unwise" chars (lib/internal/url.js:108-112). */
const unsafeProtocol = new Set(['javascript', 'javascript:']);
/** Protocols that never have a hostname (lib/internal/url.js:113-117). */
const hostlessProtocol = new Set(['javascript', 'javascript:']);
/** Protocols that always contain a // bit (lib/internal/url.js:118-136). */
const slashedProtocol = new Set([
  'http', 'http:', 'https', 'https:', 'ftp', 'ftp:', 'gopher', 'gopher:', 'file', 'file:', 'ws', 'ws:', 'wss', 'wss:',
]);

/** Node's `isURL` (lib/internal/url.js:840-842): an href and a protocol, and none of the legacy `Url`'s auth or path. */
function isURL(value: unknown): value is URL {
  const self = value as { href?: unknown; protocol?: unknown; auth?: unknown; path?: unknown } | null | undefined;
  return Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined);
}

/**
 * `domainToASCII` (lib/internal/url.js:1443-1449 over node_url.cc:224-249): Ada's `set_hostname` on a `ws://x` URL,
 * which is the URL Standard's hostname setter on a special URL. The realm's `URL` runs that setter; a setter that
 * fails leaves the host as it was, so the set is made on two hosts and a failure is where neither changed: Node's
 * empty string.
 */
function domainToASCII(...args: unknown[]): string {
  if (args.length < 1) throw new (errorCodes().ERR_MISSING_ARGS)('domain');
  const input = `${args[0]}`;
  if (input === '') return '';
  const set = (initial: string): string => {
    const url = new URL(`ws://${initial}`);
    url.hostname = input;
    return url.hostname;
  };
  const first = set('x');
  return first === set('y') ? first : '';
}

/**
 * RFC 3492's decoder, standing in for the Punycode half of `ada::idna::to_unicode`, which the engine's Ada build
 * (`../binding/ada-idna-wasm.ts`) does not export. Node's `punycode` module is not asked: loading it is DEP0040.
 */
function punycodeDecode(input: string): string {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const output: number[] = [];
  let index = input.lastIndexOf('-');
  if (index > 0) { for (let i = 0; i < index; i++) output.push(input.charCodeAt(i)); index++; } else index = 0;
  let n = 128, bias = 72, i = 0;
  while (index < input.length) {
    const start = i;
    for (let weight = 1, k = base; ; k += base) {
      if (index >= input.length) throw new RangeError('Invalid punycode input');
      const code = input.charCodeAt(index++);
      let digit: number;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30 + 26;
      else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61;
      else if (code >= 0x41 && code <= 0x5a) digit = code - 0x41;
      else throw new RangeError('Invalid punycode input');
      i += digit * weight;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      weight *= base - t;
    }
    const out = output.length + 1;
    let delta = i - start;
    delta = start === 0 ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / out);
    let k = 0;
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    bias = Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** `ada::idna::to_unicode` of a hostname the URL parser made: each `xn--` label that is valid Punycode decoded. */
export function hostnameToUnicode(ascii: string): string {
  return ascii.split('.').map((label) => {
    if (!/^xn--/i.test(label)) return label;
    try { return punycodeDecode(label.slice(4)); } catch { return label; }
  }).join('.');
}

/**
 * `domainToUnicode` (lib/internal/url.js:1451-1457 over node_url.cc:251-276): the hostname setter's answer, then
 * `ada::idna::to_unicode` of it.
 */
function domainToUnicode(...args: unknown[]): string {
  if (args.length < 1) throw new (errorCodes().ERR_MISSING_ARGS)('domain');
  const ascii = domainToASCII(`${args[0]}`);
  return ascii === '' ? '' : hostnameToUnicode(ascii);
}

/** `fileURLToPath`'s argument as a `URL`, or Node's refusal (lib/internal/url.js:1640-1648). */
function fileURL(path: unknown): URL {
  const codes = errorCodes();
  let url: URL;
  if (typeof path === 'string') url = new URL(path);
  else if (isURL(path)) url = path;
  else throw new codes.ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], path);
  if (url.protocol !== 'file:') throw new codes.ERR_INVALID_URL_SCHEME('file');
  if (url.hostname !== '') throw new codes.ERR_INVALID_FILE_URL_HOST('linux');
  return url;
}

/** `fileURLToPath` on the engine's platform, linux (lib/internal/url.js getPathFromURLPosix, 1600-1616). */
export function fileURLToPath(path: unknown): string {
  const url = fileURL(path);
  const pathname = url.pathname;
  for (let at = 0; at < pathname.length; at++) {
    if (pathname[at] === '%' && pathname[at + 1] === '2' && ((pathname.codePointAt(at + 2) ?? 0) | 0x20) === 102) {
      throw new (errorCodes().ERR_INVALID_FILE_URL_PATH)('must not include encoded / characters', url);
    }
  }
  return pathname.includes('%') ? decodeURIComponent(pathname) : pathname;
}

/** `percentDecode` (lib/internal/data_url.js:214-250): every `%XX` its byte, every other byte as it is. */
function percentDecode(input: Uint8Array): Uint8Array {
  const hex = (byte: number | undefined): number => {
    if (byte === undefined) return -1;
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
    return -1;
  };
  const output = new Uint8Array(input.length);
  let length = 0;
  for (let i = 0; i < input.length; i++) {
    const byte = input[i] as number;
    const high = byte === 0x25 ? hex(input[i + 1]) : -1;
    const low = byte === 0x25 ? hex(input[i + 2]) : -1;
    if (high < 0 || low < 0) { output[length++] = byte; continue; }
    output[length++] = (high << 4) | low;
    i += 2;
  }
  return output.subarray(0, length);
}

/** `pathToFileURL`'s escapes (node_url.cc:119-155 lookup_table, EncodePathChars 162-180 for POSIX). */
const PATH_ESCAPES: Record<string, string> = {
  '\0': '%00', '\t': '%09', '\n': '%0A', '\r': '%0D', ' ': '%20', '"': '%22', '#': '%23', '%': '%25', '?': '%3F',
  '[': '%5B', '\\': '%5C', ']': '%5D', '^': '%5E', '|': '%7C', '~': '%7E',
};

/** The `internal/url` a process's builtins and the engine's own code take. */
export function internalUrlOf(require: Require, process?: object) {
  const realmURL = (): typeof URL => (process ? processUrl(process) : (globalThis as unknown as { URL: typeof URL }).URL);
  return {
    get URL() { return realmURL(); },
    get URLSearchParams() { return (globalThis as unknown as { URLSearchParams: unknown }).URLSearchParams; },
    unsafeProtocol,
    hostlessProtocol,
    slashedProtocol,
    domainToASCII,
    domainToUnicode,
    isURL,
    fileURLToPath,
    /** `fileURLToPathBuffer` on linux (lib/internal/url.js getPathBufferFromURLPosix, 1618-1638). */
    fileURLToPathBuffer(path: unknown): Uint8Array {
      const url = fileURL(path);
      const { Buffer } = require('buffer') as { Buffer: { from(value: string | ArrayBuffer, a?: unknown, b?: number): Uint8Array } };
      const bytes = percentDecode(Buffer.from(url.pathname, 'utf8'));
      return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    },
    /**
     * `pathToFileURL` on linux (lib/internal/url.js:1666-1710 over node_url.cc PathToFileURL): `path.posix.resolve`
     * of the path, its trailing slash given back, then the URL of `file://` and the path with Node's escapes.
     */
    pathToFileURL(filepath: string): URL {
      const { posix } = require('path') as { posix: { resolve(path: string): string } };
      let resolved = posix.resolve(filepath);
      if (filepath.charCodeAt(filepath.length - 1) === 0x2f && resolved[resolved.length - 1] !== '/') resolved += '/';
      let encoded = 'file://';
      for (const character of resolved) encoded += PATH_ESCAPES[character] ?? character;
      return new (realmURL())(encoded);
    },
    /** `toPathIfFileURL`: a URL is the path it names, anything else is handed on for `fs` to validate. */
    toPathIfFileURL(value: unknown): unknown {
      return isURL(value) ? fileURLToPath(value) : value;
    },
    /**
     * `urlToHttpOptions` (lib/internal/url.js): the request options a `URL` stands for -- an IPv6 host loses its
     * brackets, the path is the pathname and the search together, and a password without a user is still an auth.
     */
    urlToHttpOptions(url: URL): Record<string, unknown> {
      const { validateObject, kValidateObjectAllowObjects } = require('internal/validators') as {
        validateObject(value: unknown, name: string, options: number): void; kValidateObjectAllowObjects: number;
      };
      validateObject(url, 'url', kValidateObjectAllowObjects);
      const { hostname, pathname, port, username, password, search } = url;
      // `...url`, in case the url object was extended by the user.
      const options: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, url, {
        protocol: url.protocol,
        hostname: hostname && hostname[0] === '[' ? hostname.slice(1, -1) : hostname,
        hash: url.hash,
        search,
        pathname,
        path: `${pathname || ''}${search || ''}`,
        href: url.href,
      });
      if (port !== '') options.port = Number(port);
      if (username || password) options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
      return options;
    },
  };
}

/** The engine's own, outside any process: the realm's `URL`, Node's other names. */
export const internalUrl = internalUrlOf((name) => nodeLibInternalRequire(name));
export const { pathToFileURL } = internalUrl;
