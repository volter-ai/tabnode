/** What `util.inspect` takes. */
export interface InspectOptions {
    depth?: number | null;
    colors?: boolean;
    showHidden?: boolean;
    customInspect?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | 'get' | 'set';
    numericSeparator?: boolean;
}
/** The whole of Node's `util` module object. */
export interface UtilModule {
    format(...args: unknown[]): string;
    formatWithOptions(options: InspectOptions, ...args: unknown[]): string;
    inspect: ((value: unknown, options?: InspectOptions) => string) & {
        custom: symbol;
        colors: Record<string, [number, number]>;
        styles: Record<string, string>;
        defaultOptions: InspectOptions;
    };
    promisify: ((fn: (...args: never[]) => void) => (...args: never[]) => Promise<unknown>) & {
        custom: symbol;
    };
    callbackify(fn: (...args: never[]) => Promise<unknown>): (...args: never[]) => void;
    deprecate<T>(fn: T, message: string, code?: string): T;
    debuglog(section: string, callback?: (fn: (...args: unknown[]) => void) => void): (...args: unknown[]) => void;
    debug: UtilModule['debuglog'];
    isDeepStrictEqual(a: unknown, b: unknown): boolean;
    parseArgs(config?: unknown): unknown;
    parseEnv(content: string): Record<string, string>;
    stripVTControlCharacters(value: string): string;
    styleText(format: string | string[], text: string, options?: unknown): string;
    toUSVString(value: string): string;
    transferableAbortController(): AbortController;
    transferableAbortSignal(signal: AbortSignal): AbortSignal;
    aborted(signal: AbortSignal, resource: object): Promise<void>;
    getSystemErrorName(errno: number): string;
    getSystemErrorMap(): Map<number, [string, string]>;
    getCallSites?: (frames?: number) => unknown[];
    types: Record<string, (value: unknown) => boolean>;
    TextEncoder: typeof TextEncoder;
    TextDecoder: typeof TextDecoder;
    MIMEType: unknown;
    MIMEParams: unknown;
    /** Node's deprecated type tests, still exported and still read by old packages. */
    isArray(value: unknown): boolean;
    isDate(value: unknown): boolean;
    isError(value: unknown): boolean;
    isFunction(value: unknown): boolean;
    isNullOrUndefined(value: unknown): boolean;
    isNumber(value: unknown): boolean;
    isObject(value: unknown): boolean;
    isPrimitive(value: unknown): boolean;
    isRegExp(value: unknown): boolean;
    isString(value: unknown): boolean;
    isUndefined(value: unknown): boolean;
    _extend(target: object, source: object): object;
    inherits(constructor: unknown, superConstructor: unknown): void;
}
/** Node's own `util.js`, built by the loader on the first property read. */
export declare const utilModule: UtilModule;
/** The two names the engine's own parts reach for directly. */
export declare const inspect: ((value: unknown, options?: InspectOptions) => string) & {
    custom: symbol;
    colors: Record<string, [number, number]>;
    styles: Record<string, string>;
    defaultOptions: InspectOptions;
};
export declare const format: (...args: unknown[]) => string;
export default utilModule;
//# sourceMappingURL=util-module.d.ts.map