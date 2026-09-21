/**
 * The internals Node's `child_process` names that `net` did not.
 *
 * Each object holds exactly the names `child_process.js` and
 * `internal/child_process.js` destructure from it, over the engine's own
 * modules. Node's real `internal/fs/utils` is two thousand lines about a
 * kernel's descriptors; what `child_process.js` takes from it is one
 * validator, run on the module path a `fork` was given.
 */
import { libRequire } from '../require-hook';
import { fileURLToPath } from '../../shims/url';

/** The codes the validators below raise, from the vendored `internal/errors.js`. */
interface ErrorCodes {
  codes: {
    ERR_INVALID_ARG_TYPE: new (name: string, expected: unknown, actual: unknown) => Error;
    ERR_INVALID_ARG_VALUE: new (name: string, value: unknown, reason?: string) => Error;
  };
}

function errorCodes(): ErrorCodes['codes'] {
  return (libRequire('internal/errors') as ErrorCodes).codes;
}

/**
 * Node's `validatePath`: a path is a string or a `Uint8Array`, and it carries
 * no NUL. `fork('a\u0000b')` is a program's own bug and Node says so rather
 * than opening a file whose name stops at the NUL.
 */
function validatePath(path: unknown, propName = 'path'): void {
  const codes = errorCodes();
  const isString = typeof path === 'string';
  const isBytes = path instanceof Uint8Array;
  if (!isString && !isBytes) {
    throw new codes.ERR_INVALID_ARG_TYPE(propName, ['string', 'Buffer', 'URL'], path);
  }
  if (isString ? !path.includes('\u0000') : !(path as Uint8Array).includes(0)) return;
  throw new codes.ERR_INVALID_ARG_VALUE(
    propName, path, 'must be a string, Uint8Array, or URL without null bytes',
  );
}

/**
 * Node's `getValidatedPath`: a `file:` URL is the path it names, and anything
 * else is validated as it stands. `fork(new URL('file:///app/child.js'))` is
 * an ordinary call and `test-child-process-fork-url.mjs` makes it.
 */
function getValidatedPath(fileURLOrPath: unknown, propName = 'path'): string | Uint8Array {
  const path = fileURLOrPath instanceof URL || (typeof fileURLOrPath === 'string' && fileURLOrPath.startsWith('file://'))
    ? fileURLToPath(fileURLOrPath as URL | string)
    : fileURLOrPath;
  validatePath(path, propName);
  return path as string | Uint8Array;
}

export const internalFsUtils = { getValidatedPath, validatePath };

/**
 * `internal/dgram`: the one name `internal/child_process.js` reads from it,
 * the symbol a `dgram.Socket` keeps its handle under. The engine's `dgram` is
 * a stub with no handle, so nothing is ever sent this way; the symbol exists
 * because the conversion table names it while it is built.
 */
export const internalDgram = { kStateSymbol: Symbol('state symbol') };
