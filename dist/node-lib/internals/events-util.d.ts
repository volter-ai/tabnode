/**
 * The internals Node's `events`, `util` and `internal/util/inspect` name that
 * are not vendored.
 *
 * Each is the whole of what those files take from it. Every one of them is
 * required lazily, inside the function that needs it -- Node wrote them that
 * way to break its own cycles -- so nothing here is built unless a program
 * walks the path that asks.
 */
/** `internal/console/global`: the realm's console, which `util.debuglog` logs through. */
export declare const internalConsoleGlobal: Record<string, unknown>;
/**
 * `internal/process/execution`: the one call `internal/util.js` makes into
 * it, reading the working directory where a failure to read it is not an
 * error but an empty answer.
 */
export declare const internalProcessExecution: {
    tryGetCwd: () => string;
};
/**
 * `internal/process/warning`: Node emits a warning on the next tick through
 * `process.emitWarning`, and synchronously through this one where the tick
 * would come too late -- a deprecation raised while the process is exiting.
 */
export declare const internalProcessWarning: {
    emitWarningSync: (warning: unknown, type?: string, code?: string) => void;
};
/**
 * `internal/source_map/source_map_cache`: a tab compiles no source maps into
 * the engine's own error stacks. Each name answers the way Node's does with
 * source maps switched off.
 */
export declare const internalSourceMapCache: {
    findSourceMap: () => undefined;
    maybeCacheSourceMap: () => void;
    sourceMapCacheToObject: () => undefined;
    getSourceMapsSupport: () => {
        enabled: boolean;
        nodeModules: boolean;
        generatedCode: boolean;
    };
    setSourceMapsSupport: () => void;
    rekeySourceMap: () => void;
};
/**
 * `internal/deps/undici/undici`: what `http.js` reaches for when a program
 * touches `http.WebSocket`, `http.CloseEvent` or `http.MessageEvent`.
 *
 * Node bundles undici to have those classes at all. A tab already has them --
 * they are the platform's, and they are what `new WebSocket(url)` means
 * everywhere else on the page -- so the realm's own are what the engine
 * answers with, rather than a second implementation of the same three names.
 */
export declare const internalUndici: {
    readonly WebSocket: unknown;
    readonly CloseEvent: unknown;
    readonly MessageEvent: unknown;
};
/**
 * `internal/readline/interface`: the one name `internal/fs/promises.js`
 * takes from it, at its top, so every use of `fs/promises` needs it.
 * `filehandle.readLines()` builds one of these over the file's own stream;
 * the engine's `readline` already has that class, over the same streams.
 */
export declare const internalReadlineInterface: {
    readonly Interface: unknown;
};
/**
 * `internal/worker/js_transferable`: the marks Node puts on an object that
 * can cross a `postMessage`. `internal/fs/promises.js` marks its `FileHandle`
 * so one can be sent to a worker. Nothing crosses a thread boundary here --
 * a handle is a number in this engine's own table -- so the marks are the
 * symbols and a no-op, which is what an unmarked object gets anyway.
 */
export declare const internalJsTransferable: {
    markTransferMode: () => void;
    kDeserialize: symbol;
    kTransfer: symbol;
    kTransferList: symbol;
    kClone: symbol;
    setDeserializerCreateObjectFunction: () => void;
};
//# sourceMappingURL=events-util.d.ts.map