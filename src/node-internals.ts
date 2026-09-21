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

import { inspect } from './node-lib/util-module';

/** Node's util.inspect, for the primitives that reach an error message. */
export function inspectValue(value: unknown): string {
  if (typeof value === 'string') {
    const escaped = value.replace(/\n/g, '\\n');
    if (!escaped.includes("'")) return `'${escaped}'`;
    if (!escaped.includes('"')) return `"${escaped}"`;
    return `\`${escaped}\``;
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  return String(value);
}

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
export function determineSpecificType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number': {
      const number = value as number;
      if (number === 0) return 1 / number === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (number !== number) return 'type number (NaN)';
      if (number === Infinity) return 'type number (Infinity)';
      if (number === -Infinity) return 'type number (-Infinity)';
      return `type number (${number})`;
    }
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${(value as { name?: string }).name}`;
    case 'object': {
      const ctor = (value as { constructor?: object }).constructor;
      if (ctor && 'name' in ctor) return `an instance of ${(ctor as { name?: string }).name}`;
      // Node: inspect(value, { depth: -1 }). The engine's util.inspect answers
      // `[Object]` where Node answers `[Object: null prototype]`; reached only
      // by an object whose constructor is gone, which Node's tests do not.
      return `${inspect(value, { depth: -1 })}`;
    }
    case 'string': {
      let text = value as string;
      if (text.length > 28) text = `${text.slice(0, 25)}...`;
      if (text.indexOf("'") === -1) return `type string ('${text}')`;
      return `type string (${JSON.stringify(text)})`;
    }
    default: {
      let inspected = inspect(value, { colors: false });
      if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
      return `type ${type} (${inspected})`;
    }
  }
}

const kTypes = [
  'string', 'function', 'number', 'object',
  'Function', 'Object', 'boolean', 'bigint', 'symbol',
];
/** lib/internal/errors.js: an expectation spelled as a class name. */
const classRegExp = /^([A-Z][a-z0-9]*)+$/;

/**
 * lib/internal/errors.js ERR_INVALID_ARG_TYPE. Node sorts each expectation
 * into three buckets — a primitive `type`, a class `instance`, anything else —
 * and the engine had only two, so every validator that expects a class said
 * "must be an Array" where Node says "must be an instance of Array"
 * (`node:wasi`'s `validateArray(options.args)`,
 * test-wasi-options-validation.js).
 */
export class ERR_INVALID_ARG_TYPE extends TypeError {
  code = 'ERR_INVALID_ARG_TYPE';
  constructor(name: string, expected: string | string[], actual: unknown) {
    const expectations = Array.isArray(expected) ? [...expected] : [expected];
    let message = 'The ';
    if (name.endsWith(' argument')) {
      message += `${name} `;
    } else {
      message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
    }
    message += 'must be ';

    const types: string[] = [];
    const instances: string[] = [];
    const other: string[] = [];
    for (const value of expectations) {
      if (kTypes.includes(value)) types.push(value.toLowerCase());
      else if (classRegExp.exec(value) !== null) instances.push(value);
      else other.push(value);
    }

    // Node: where a class is also expected, plain `object` becomes `Object`,
    // so the message tells the instances apart.
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) {
        types.splice(pos, 1);
        instances.push('Object');
      }
    }

    if (types.length > 0) {
      if (types.length > 2) {
        const last = types.pop();
        message += `one of type ${types.join(', ')}, or ${last}`;
      } else if (types.length === 2) {
        message += `one of type ${types[0]} or ${types[1]}`;
      } else {
        message += `of type ${types[0]}`;
      }
      if (instances.length > 0 || other.length > 0) message += ' or ';
    }

    if (instances.length > 0) {
      if (instances.length > 2) {
        const last = instances.pop();
        message += `an instance of ${instances.join(', ')}, or ${last}`;
      } else {
        message += `an instance of ${instances[0]}`;
        if (instances.length === 2) message += ` or ${instances[1]}`;
      }
      if (other.length > 0) message += ' or ';
    }

    if (other.length > 0) {
      if (other.length > 2) {
        const last = other.pop();
        message += `one of ${other.join(', ')}, or ${last}`;
      } else if (other.length === 2) {
        message += `one of ${other[0]} or ${other[1]}`;
      } else {
        if (other[0].toLowerCase() !== other[0]) message += 'an ';
        message += `${other[0]}`;
      }
    }

    message += `. Received ${determineSpecificType(actual)}`;
    super(message);
    // Node restores the built-in name and carries the code beside it, so a
    // guest's `err instanceof TypeError` and `err.name === 'TypeError'` hold.
    this.name = 'TypeError';
  }
}

export class ERR_INVALID_ARG_VALUE extends TypeError {
  code = 'ERR_INVALID_ARG_VALUE';
  constructor(name: string, value: unknown, reason = 'is invalid') {
    const type = name.includes('.') ? 'property' : 'argument';
    super(`The ${type} '${name}' ${reason}. Received ${inspectValue(value)}`);
    this.name = 'TypeError';
  }
}

/**
 * lib/internal/errors.js `addNumericSeparator`: Node groups a large integer's
 * digits in an out-of-range message, so `281474976710656` is reported as
 * `281_474_976_710_656` (test-crypto-random.js asserts that form for
 * `crypto.randomInt`'s range). The engine printed the bare digits.
 */
function addNumericSeparator(value: string): string {
  let tail = '';
  let index = value.length;
  const start = value[0] === '-' ? 1 : 0;
  for (; index >= start + 4; index -= 3) tail = `_${value.slice(index - 3, index)}${tail}`;
  return `${value.slice(0, index)}${tail}`;
}

export class ERR_OUT_OF_RANGE extends RangeError {
  code = 'ERR_OUT_OF_RANGE';
  constructor(name: string, range: string, value: unknown) {
    // Node separates the digits of an integer past 2**32, and of a bigint
    // past the same, and inspects everything else.
    let received: string;
    if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
      received = addNumericSeparator(String(value));
    } else if (typeof value === 'bigint') {
      received = String(value);
      if (value > 2n ** 32n || value < -(2n ** 32n)) received = addNumericSeparator(received);
      received += 'n';
    } else {
      received = inspectValue(value);
    }
    super(`The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
    this.name = 'RangeError';
  }
}

// ---------------------------------------------------------------------------
// internal/validators — the names path.js and wasi.js take from it.
// ---------------------------------------------------------------------------

export function validateString(value: unknown, name: string): void {
  if (typeof value !== 'string') throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
}

export function validateObject(value: unknown, name: string): void {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

export function validateArray(value: unknown, name: string, minLength = 0): void {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) {
    throw new ERR_INVALID_ARG_VALUE(name, value, `must be longer than ${minLength}`);
  }
}

export function validateBoolean(value: unknown, name: string): void {
  if (typeof value !== 'boolean') throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

export function validateFunction(value: unknown, name: string): void {
  if (typeof value !== 'function') throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
}

/** lib/internal/errors.js ERR_UNKNOWN_ENCODING, as `new StringDecoder('x')` raises it. */
export class ERR_UNKNOWN_ENCODING extends TypeError {
  code = 'ERR_UNKNOWN_ENCODING';
  constructor(encoding: unknown) {
    super(`Unknown encoding: ${String(encoding)}`);
    this.name = 'TypeError';
  }
}

/** lib/internal/errors.js ERR_INVALID_THIS: a prototype method called off an instance. */
export class ERR_INVALID_THIS extends TypeError {
  code = 'ERR_INVALID_THIS';
  constructor(type: string) {
    super(`Value of "this" must be of type ${type}`);
    this.name = 'TypeError';
  }
}

/** lib/internal/errors.js ERR_STRING_TOO_LONG: past V8's longest string. */
export class ERR_STRING_TOO_LONG extends RangeError {
  code = 'ERR_STRING_TOO_LONG';
  constructor(max: number) {
    super(`Cannot create a string longer than 0x${max.toString(16)} characters`);
    this.name = 'RangeError';
  }
}

export function validateNumber(value: unknown, name: string): void {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
}

export function validateUndefined(value: unknown, name: string): void {
  if (value !== undefined) throw new ERR_INVALID_ARG_TYPE(name, 'undefined', value);
}

export function validateInt32(value: unknown, name: string, min = -2147483648, max = 2147483647): void {
  if (typeof value !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}
