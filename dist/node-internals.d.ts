/**
 * The Node internals a vendored `lib/*.js` file asks its binding for:
 * `internal/errors` codes and `internal/validators`, with Node's messages.
 *
 * A guest reads `err.code` and `err.message`, and Node's own tests read both
 * (test-path-parse-format.js asserts the ERR_INVALID_ARG_TYPE text word for
 * word; test-wasi-options-validation.js matches the property names), so each
 * message is assembled the way lib/internal/errors.js assembles it. These
 * began in `shims/path.ts`, the first Node file run on a binding; `shims/wasi.ts`
 * is the second, and both bind here.
 */
/** Node's util.inspect, for the primitives that reach an error message. */
export declare function inspectValue(value: unknown): string;
/**
 * lib/internal/errors.js `determineSpecificType`, the "Received ..." tail of
 * every ERR_INVALID_ARG_TYPE. Node switches on `typeof` and never inspects a
 * function: a function is `function <name>`, and an anonymous one is
 * `function ` with the empty name, not `type function (() => {\n})`. The engine
 * inspected it, so every builtin that validated an argument printed a
 * program's own source back at it where Node prints a name
 * (`node:wasi`'s `new WASI(() => {})`, test-wasi-options-validation.js).
 * Transcribed from Node 22's source, case for case.
 */
export declare function determineSpecificType(value: unknown): string;
/**
 * lib/internal/errors.js ERR_INVALID_ARG_TYPE. Node sorts each expectation
 * into three buckets — a primitive `type`, a class `instance`, anything else —
 * and the engine had only two, so every validator that expects a class said
 * "must be an Array" where Node says "must be an instance of Array"
 * (`node:wasi`'s `validateArray(options.args)`,
 * test-wasi-options-validation.js).
 */
export declare class ERR_INVALID_ARG_TYPE extends TypeError {
    code: string;
    constructor(name: string, expected: string | string[], actual: unknown);
}
export declare class ERR_INVALID_ARG_VALUE extends TypeError {
    code: string;
    constructor(name: string, value: unknown, reason?: string);
}
export declare class ERR_OUT_OF_RANGE extends RangeError {
    code: string;
    constructor(name: string, range: string, value: unknown);
}
export declare function validateString(value: unknown, name: string): void;
export declare function validateObject(value: unknown, name: string): void;
export declare function validateArray(value: unknown, name: string, minLength?: number): void;
export declare function validateBoolean(value: unknown, name: string): void;
export declare function validateFunction(value: unknown, name: string): void;
/** lib/internal/errors.js ERR_UNKNOWN_ENCODING, as `new StringDecoder('x')` raises it. */
export declare class ERR_UNKNOWN_ENCODING extends TypeError {
    code: string;
    constructor(encoding: unknown);
}
/** lib/internal/errors.js ERR_INVALID_THIS: a prototype method called off an instance. */
export declare class ERR_INVALID_THIS extends TypeError {
    code: string;
    constructor(type: string);
}
/** lib/internal/errors.js ERR_STRING_TOO_LONG: past V8's longest string. */
export declare class ERR_STRING_TOO_LONG extends RangeError {
    code: string;
    constructor(max: number);
}
export declare function validateNumber(value: unknown, name: string): void;
export declare function validateUndefined(value: unknown, name: string): void;
export declare function validateInt32(value: unknown, name: string, min?: number, max?: number): void;
//# sourceMappingURL=node-internals.d.ts.map