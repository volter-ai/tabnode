export declare const constantsBinding: Record<string, unknown>;
export declare const osBinding: {
    /** Node's `os.type()`, `release()` and `version()`, in that order. */
    getOSInformation: () => string[];
    getHostname: () => string;
    getHomeDirectory: () => string;
    getUptime: () => number;
    getTotalMem: () => number;
    getFreeMem: () => number;
    getLoadAvg: (array: Float64Array) => void;
    getAvailableParallelism: () => number;
    isBigEndian: boolean;
    /**
     * Node reads its CPU list as a flat array: a model and a speed, then the
     * five time counters, for each core.
     */
    getCPUs: () => Array<string | number>;
    /**
     * The same shape for interfaces: name, address, netmask, family, mac,
     * scope id, then the CIDR, per address.
     */
    getInterfaceAddresses: () => Array<string | number | boolean>;
    getUserInfo: () => Record<string, unknown>;
    /**
     * A process's niceness. A tab has no scheduler to hand it to, but the pair
     * still has to agree: a program that sets a priority and reads it back must
     * see what it set, which is what `test-os.js` checks. The value is this
     * engine's, per pid, and changes nothing about how anything runs.
     */
    getPriority: (pid: number) => number;
    setPriority: (pid: number, priority: number) => number;
};
/**
 * `internalBinding('credentials')`: the one name `os.js` takes from it. A tab
 * has no environment of its own to read `TMPDIR` from, so the answer is the
 * directory the engine's `os` calls its temporary one.
 */
export declare const credentialsBinding: {
    /**
     * Where a temporary file goes. Node reads `TMPDIR`, then `TMP`, then
     * `TEMP` from the environment and falls back to the platform's directory,
     * dropping a trailing slash; a program that sets `TMPDIR` expects to be
     * obeyed, which is what `test-os.js` checks.
     */
    getTempDir: () => string;
};
/**
 * `internalBinding('encoding_binding')`: the punycode conversion `url.js`
 * makes for a host name, out of the engine's own `punycode`.
 */
export declare const encodingBinding: {
    toASCII: (value: string) => string;
    toUnicode: (value: string) => string;
};
/**
 * `internalBinding('config')`: the build switches Node's own files read. The
 * engine has no ICU, so `buffer.transcode` is not defined -- which is what
 * Node without ICU does, and is the one thing `buffer.js` loses here.
 */
export declare const configBinding: {
    hasIntl: boolean;
    hasSmallICU: boolean;
    hasNodeOptions: boolean;
    hasInspector: boolean;
    noBrowserGlobals: boolean;
    bits: number;
    hasOpenSSL: boolean;
    fipsMode: boolean;
    hasDtrace: boolean;
};
/**
 * `internalBinding('fs')`: `internal/net.js`'s `makeSyncWrite` writes a
 * descriptor synchronously, which Node does only for Windows' stdout and
 * stderr. The engine's platform is `linux` and nothing reaches it.
 */
export declare const fsBinding: {
    writeBuffer: (_fd: number, _buffer: Uint8Array, _offset: number, _length: number, _position: unknown, _req: unknown, ctx: {
        errno?: number;
        syscall?: string;
    }) => number;
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
export declare const stringDecoderBinding: {
    encodings: string[];
};
/**
 * `internalBinding('trace_events')`: the tracing category buffer
 * `internal/util/debuglog.js` reads to decide whether a section is traced.
 * Nothing in a tab is traced, so every category reads 0 -- which is what
 * `debuglog` checks before it formats anything.
 */
export declare const traceEventsBinding: {
    getCategoryEnabledBuffer: () => Uint8Array;
    trace: () => void;
};
/**
 * `internalBinding('messaging')`: `internal/util.js` reaches for
 * `DOMException` through it, which the realm already has.
 */
export declare const messagingBinding: {
    readonly DOMException: unknown;
};
/**
 * `internalBinding('errors')`: the one call `diagnostics_channel.js` makes
 * into it. A subscriber that throws must not be swallowed and must not take
 * the publisher with it, so Node hands the error to the process as an
 * uncaught exception. The engine has that door already -- it is how a run
 * reports a throw nobody caught -- and this reaches it through the realm's
 * own process, which is the run's.
 */
export declare const errorsBinding: {
    triggerUncaughtException: (error: unknown, fromPromise?: boolean) => void;
};
//# sourceMappingURL=misc.d.ts.map