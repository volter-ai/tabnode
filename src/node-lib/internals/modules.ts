/**
 * The internals Node's `internal/modules/customization_hooks.js` names.
 *
 * Each object holds exactly the names that file destructures from it. Node's
 * real `internal/bootstrap/realm` is the builtin loader of a Node process --
 * a snapshot, a compile cache and every `lib/` file -- and what the hooks file
 * takes from it is two questions about a name: is this something a program can
 * require, and what is its canonical id. The engine answers both from the same
 * list its `module.builtinModules` reports, so a hook that reads `node:fs`
 * reads the name the guest's own `module.isBuiltin` agrees with.
 */
import * as moduleShim from '../../shims/module';
import { fileURLToPath, pathToFileURL } from '../../shims/url';

/**
 * `internal/bootstrap/realm`'s `BuiltinModule`, the two class methods the
 * hooks file calls to turn a CommonJS filename into a URL and back.
 */
export const internalBootstrapRealm = {
  BuiltinModule: {
    /**
     * Whether a normalized id (no `node:`) is a builtin a program may require.
     * Node asks this of a filename to decide whether it is `node:<id>` rather
     * than a path; a name the engine does not answer is a path or nothing.
     */
    canBeRequiredByUsers(id: string): boolean {
      return moduleShim.builtinModules.includes(id);
    },
    /**
     * The canonical id of a requirable builtin, `node:` prefix or not, and
     * undefined for anything else -- a `file:` URL, a path, a bare package
     * name. Node returns undefined rather than throwing, and the hooks file
     * tests the result rather than catching.
     */
    normalizeRequirableId(id: string): string | undefined {
      if (typeof id !== 'string') return void 0;
      const name = id.startsWith('node:') ? id.slice(5) : id;
      return moduleShim.builtinModules.includes(name) ? name : void 0;
    },
    /**
     * Whether `id` is a compiled builtin, which `internal/util/inspect`
     * asks of every `node:` stack frame when it colorizes an Error. Node's
     * class answers from the realm's module map; the engine answers from
     * the same list `canBeRequiredByUsers` reads, plus `internal/` files
     * inspect also greys. The method was missing, so a pipe child that
     * still had FORCE_COLOR threw `exists is not a function` while printing
     * an assertion and the test exited 1.
     */
    exists(id: string): boolean {
      if (typeof id !== 'string') return false;
      const name = id.startsWith('node:') ? id.slice(5) : id;
      return name.startsWith('internal/') || moduleShim.builtinModules.includes(name);
    },
  },
};

/**
 * `internal/url`: the conversions between a path and a URL that the hooks
 * file makes, and the three names `_http_client.js` and `https.js` take to
 * turn a URL into the options a request is made from.
 */
export const internalUrl = {
  fileURLToPath,
  pathToFileURL,
  /**
   * Node's `toPathIfFileURL`: `fs` takes a path or a `file:` URL for every
   * one of its calls, and this is the one line that turns the second into
   * the first. Anything else is handed on untouched, for `fs` to validate.
   */
  toPathIfFileURL: (value: unknown): unknown => {
    if (value instanceof URL) return fileURLToPath(value);
    if (typeof value === 'string' && value.startsWith('file://')) return fileURLToPath(value);
    return value;
  },
  get URL() { return (globalThis as unknown as { URL: unknown }).URL; },
  /** Node's `isURL`: a `URL` of this realm, or one shaped like it. */
  isURL: (value: unknown): boolean =>
    value instanceof URL ||
    (value !== null && typeof value === 'object' &&
      typeof (value as { href?: unknown }).href === 'string' &&
      typeof (value as { origin?: unknown }).origin === 'string' &&
      typeof (value as { protocol?: unknown }).protocol === 'string'),
  /**
   * Node's `urlToHttpOptions`: the request options a `URL` stands for. The
   * rules are Node's own -- an IPv6 host loses its brackets, the path is the
   * pathname and the search together, and a password without a user is still
   * an auth pair.
   */
  urlToHttpOptions: (url: URL): Record<string, unknown> => {
    const options: Record<string, unknown> = {
      protocol: url.protocol,
      hostname: typeof url.hostname === 'string' && url.hostname.startsWith('[')
        ? url.hostname.slice(1, -1)
        : url.hostname,
      hash: url.hash,
      search: url.search,
      pathname: url.pathname,
      path: `${url.pathname || ''}${url.search || ''}`,
      href: url.href,
    };
    if (url.port !== '') options.port = Number(url.port);
    if (url.username || url.password) {
      options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    }
    return options;
  },
};

/**
 * `internal/encoding`: the realm's own `TextDecoder`. The hooks file decodes
 * an `ArrayBuffer` or a typed array a load hook returned into the source
 * string the loader compiles.
 */
export const internalEncoding = {
  get TextDecoder() { return (globalThis as unknown as { TextDecoder: unknown }).TextDecoder; },
  get TextEncoder() { return (globalThis as unknown as { TextEncoder: unknown }).TextEncoder; },
};
