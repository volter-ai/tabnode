/**
 * `internalBinding('util')`: what V8 tells Node about a value.
 *
 * `internal/util/inspect.js` is the reason this file is the size it is.
 * Printing a value the way Node prints it means asking V8 questions
 * JavaScript cannot ask itself, and each one is answered here out of the
 * realm's own built-ins -- an object's non-index properties, the name of the
 * constructor that made it, the entries inside a `Map` or a `Set`.
 *
 * THE TWO NAMED LOSSES, and why they are losses rather than gaps to close:
 *
 * `getProxyDetails` asks V8 for a `Proxy`'s target and handler. A proxy is
 * invisible to the code it wraps -- that is the whole of what a proxy is --
 * and no JavaScript can see through one. This answers undefined, which is
 * `not a proxy`, so `inspect` prints the value the proxy stands for. That is
 * also what Node prints without `--show-proxy`, so the loss shows only under
 * `showProxy: true`.
 *
 * `defineLazyProperties` is how `util.js` exposes `parseArgs`, `TextDecoder`,
 * `MIMEType` and the rest: each is a getter that requires its own file on the
 * first read. It must reach the loader's require, not the realm's -- there is
 * no `require` on a realm -- or every one of those names reads undefined.
 *
 * `getConstructorName` asks V8 which constructor made a value, which V8 knows
 * from the object's own shape even after its prototype has been severed.
 * This walks the prototype chain for an own `constructor`, which is the only
 * record JavaScript keeps -- so an object whose prototype was set to null
 * prints as `[Object: null prototype]` where Node prints `[Foo: null
 * prototype]`. Everything with a prototype still names its constructor.
 *
 * `getPromiseDetails` asks V8 for a promise's state and its value without
 * awaiting it. A promise's state cannot be read synchronously from
 * JavaScript; `then` is the only door and it is asynchronous by definition.
 * This answers `[kPending]`, so `inspect` prints `Promise { <pending> }` for
 * every promise, settled or not. A program that needs to know awaits it.
 */
import { guessHandleTypeOfFd } from './fds';
export declare const utilBinding: {
    privateSymbols: {
        arrow_message_private_symbol: symbol;
        decorated_private_symbol: symbol;
        untransferable_object_private_symbol: symbol;
        host_defined_option_symbol: symbol;
        transfer_mode_private_symbol: symbol;
    };
    constants: {
        ALL_PROPERTIES: number;
        ONLY_WRITABLE: number;
        ONLY_ENUMERABLE: number;
        ONLY_CONFIGURABLE: number;
        SKIP_STRINGS: number;
        SKIP_SYMBOLS: number;
        kPending: number;
        kFulfilled: number;
        kRejected: number;
    };
    /** Node warns differently for a deprecation raised inside a dependency; nothing here is. */
    isInsideNodeModules: () => boolean;
    /**
     * An object's own properties that are not array indices, filtered the way
     * V8's `GetOwnNonIndexProperties` filters: `ONLY_ENUMERABLE` keeps the
     * enumerable ones, `SKIP_SYMBOLS` and `SKIP_STRINGS` drop a kind outright.
     * `inspect` asks for this to list an array's non-index keys and a typed
     * array's own properties without walking its elements.
     */
    getOwnNonIndexProperties: (target: object, filter?: number) => Array<string | symbol>;
    /** The promise loss named at the top of this file. */
    getPromiseDetails: () => [number];
    /** The proxy loss named at the top of this file. */
    getProxyDetails: () => undefined;
    /**
     * The entries inside a `Map` or a `Set`, which `inspect` prints. V8 reads
     * them out of the object's own storage; this reads them the way any program
     * does, which answers for a real map or set. An ITERATOR over one keeps its
     * position in V8's own state and cannot be previewed without consuming it,
     * so an iterator previews as empty rather than being spent -- a printed
     * value is not worth destroying the thing printed.
     */
    previewEntries: (value: unknown, isIterator?: boolean) => [unknown[], boolean];
    /**
     * The name of the constructor that made a value, as V8 reports it: the
     * first prototype in the chain with an own `constructor` whose name is not
     * empty. `inspect` prints it before an object's braces.
     */
    getConstructorName: (value: object) => string;
    /** A pointer's value, printed for an external. A tab has no externals. */
    getExternalValue: () => bigint;
    /** What kind of thing a descriptor is, out of the engine's own table. */
    guessHandleType: typeof guessHandleTypeOfFd;
    /**
     * Node's `defineLazyProperties`: each key becomes a getter that requires
     * the module the first time it is read, so a builtin that exposes another
     * builtin's class does not load it to say so.
     */
    defineLazyProperties: (target: object, id: string, keys: string[], writable?: boolean) => void;
    /**
     * The stack, as `util.getCallSites()` reports it: one entry per frame with
     * the function's name, the script it is in, and where in that script. V8's
     * own structured-stack door is what Node reads too -- `Error
     * .prepareStackTrace` handed an array of call sites -- so this asks the
     * realm the same question and shapes the answer the same way. The harness
     * of Node's own tests calls it on every `mustNotCall`, which is why a
     * missing one showed up as thirty test files at once.
     */
    getCallSites: (frameCount?: number) => Array<Record<string, unknown>>;
    /**
     * A `.env` file's contents as an object, which `util.parseEnv` returns and
     * which `--env-file` loads a process's environment from. Node parses it in
     * C++; the rules are the ones its own fixture states, and they are the
     * whole of the format: a `KEY=VALUE` per line, `export ` allowed in front
     * of the key and dropped, a `#` starting a comment outside quotes wherever
     * it stands -- `a#b` is `a`, no space needed -- and a
     * value that may be wrapped in single quotes, double quotes or backticks --
     * a quoted value keeps its spaces and may run over several lines, and only
     * a double-quoted one expands `\n` and `\r`.
     */
    parseEnv: (content: string) => Record<string, string>;
    /**
     * A blocking sleep. A tab has one thread and nothing else can run while
     * this spins, which is exactly what a blocking sleep is; only a program
     * that asked for one gets it.
     */
    sleep: (milliseconds: number) => void;
};
export default utilBinding;
//# sourceMappingURL=util.d.ts.map