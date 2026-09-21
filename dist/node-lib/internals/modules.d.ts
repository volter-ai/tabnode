import { fileURLToPath, pathToFileURL } from '../../shims/url';
/**
 * `internal/bootstrap/realm`'s `BuiltinModule`, the two class methods the
 * hooks file calls to turn a CommonJS filename into a URL and back.
 */
export declare const internalBootstrapRealm: {
    BuiltinModule: {
        /**
         * Whether a normalized id (no `node:`) is a builtin a program may require.
         * Node asks this of a filename to decide whether it is `node:<id>` rather
         * than a path; a name the engine does not answer is a path or nothing.
         */
        canBeRequiredByUsers(id: string): boolean;
        /**
         * The canonical id of a requirable builtin, `node:` prefix or not, and
         * undefined for anything else -- a `file:` URL, a path, a bare package
         * name. Node returns undefined rather than throwing, and the hooks file
         * tests the result rather than catching.
         */
        normalizeRequirableId(id: string): string | undefined;
        /**
         * Whether `id` is a compiled builtin, which `internal/util/inspect`
         * asks of every `node:` stack frame when it colorizes an Error. Node's
         * class answers from the realm's module map; the engine answers from
         * the same list `canBeRequiredByUsers` reads, plus `internal/` files
         * inspect also greys. The method was missing, so a pipe child that
         * still had FORCE_COLOR threw `exists is not a function` while printing
         * an assertion and the test exited 1.
         */
        exists(id: string): boolean;
    };
};
/**
 * `internal/url`: the conversions between a path and a URL that the hooks
 * file makes, and the three names `_http_client.js` and `https.js` take to
 * turn a URL into the options a request is made from.
 */
export declare const internalUrl: {
    fileURLToPath: typeof fileURLToPath;
    pathToFileURL: typeof pathToFileURL;
    /**
     * Node's `toPathIfFileURL`: `fs` takes a path or a `file:` URL for every
     * one of its calls, and this is the one line that turns the second into
     * the first. Anything else is handed on untouched, for `fs` to validate.
     */
    toPathIfFileURL: (value: unknown) => unknown;
    readonly URL: unknown;
    /** Node's `isURL`: a `URL` of this realm, or one shaped like it. */
    isURL: (value: unknown) => boolean;
    /**
     * Node's `urlToHttpOptions`: the request options a `URL` stands for. The
     * rules are Node's own -- an IPv6 host loses its brackets, the path is the
     * pathname and the search together, and a password without a user is still
     * an auth pair.
     */
    urlToHttpOptions: (url: URL) => Record<string, unknown>;
};
/**
 * `internal/encoding`: the realm's own `TextDecoder`. The hooks file decodes
 * an `ArrayBuffer` or a typed array a load hook returned into the source
 * string the loader compiles.
 */
export declare const internalEncoding: {
    readonly TextDecoder: unknown;
    readonly TextEncoder: unknown;
};
//# sourceMappingURL=modules.d.ts.map