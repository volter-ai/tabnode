/**
 * `process.env` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's src/node_env_var.cc. Its store is
 * RealEnvStore, the process's own environment (libc's environ, through libuv: native/node/node_env_var.c), so what
 * JavaScript sets is what libuv, OpenSSL, libc and the process's children read; its object is the Environment's env
 * proxy, an ordinary object whose named properties EnvGetter, EnvSetter, EnvQuery, EnvDeleter, EnvEnumerator and
 * EnvDefiner intercept, a name they do not answer falling through to the object and its prototype as V8's
 * interceptors fall through.
 */
import { address, nodeProgram, withCString } from './program';

/** UV_ENOBUFS. */
const UV_ENOBUFS = -105;

const decoder = new TextDecoder();

/** KVStore's interface (src/node_env_var.h) over RealEnvStore. */
export interface EnvStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
}

/** RealEnvStore (node_env_var.cc:105-218): each operation libuv's over libc's environ. */
export const realEnvStore: EnvStore = {
  /** Get (105-124): uv_os_getenv into 256 bytes, again into the size it asked for where they were too few. */
  get(key) {
    const program = nodeProgram();
    return withCString(key, (keyAt) => {
      const sizeAt = address(program.exports.tabnode_malloc(4));
      let size = 256;
      let buffer = address(program.exports.tabnode_malloc(size));
      try {
        const view = (): DataView => new DataView(program.read(sizeAt, 4).slice().buffer);
        const ask = (): number => {
          program.write(sizeAt, new Uint8Array(new Uint32Array([size]).buffer));
          return program.exports.tabnode_getenv(keyAt, buffer, sizeAt);
        };
        let err = ask();
        if (err === UV_ENOBUFS) {
          size = view().getUint32(0, true);
          program.exports.tabnode_free(buffer);
          buffer = address(program.exports.tabnode_malloc(size));
          err = ask();
        }
        if (err < 0) return undefined;
        return decoder.decode(program.read(buffer, view().getUint32(0, true)));
      } finally {
        program.exports.tabnode_free(buffer);
        program.exports.tabnode_free(sizeAt);
      }
    });
  },
  /** Set (144-156): uv_os_setenv. */
  set(key, value) {
    withCString(key, (keyAt) => withCString(value, (valueAt) => nodeProgram().exports.tabnode_setenv(keyAt, valueAt)));
  },
  /** Query (159-179): uv_os_getenv into two bytes; present unless it answers UV_ENOENT. */
  has(key) {
    const program = nodeProgram();
    return withCString(key, (keyAt) => {
      const sizeAt = address(program.exports.tabnode_malloc(4 + 2));
      try {
        program.write(sizeAt, new Uint8Array(new Uint32Array([2]).buffer));
        return program.exports.tabnode_getenv(keyAt, sizeAt + 4, sizeAt) !== -2;
      } finally { program.exports.tabnode_free(sizeAt); }
    });
  },
  /** Delete (186-192): uv_os_unsetenv. */
  delete(key) {
    withCString(key, (keyAt) => nodeProgram().exports.tabnode_unsetenv(keyAt));
  },
  /** Enumerate (194-218): uv_os_environ's names. */
  keys() {
    const program = nodeProgram();
    const countAt = address(program.exports.tabnode_malloc(4));
    try {
      const items = program.exports.tabnode_environ(countAt);
      if (items === 0) throw new Error('uv_os_environ failed');
      const count = new DataView(program.read(countAt, 4).slice().buffer).getInt32(0, true);
      try {
        const names: string[] = [];
        for (let index = 0; index < count; index++) names.push(program.cString(program.exports.tabnode_environ_name(items, index)) ?? '');
        return names;
      } finally { program.exports.tabnode_environ_free(items, count); }
    } finally { program.exports.tabnode_free(countAt); }
  },
};

/**
 * The Environment's env proxy (node_env_var.cc:427-584) over `store`. A symbol reads undefined; a name the store does
 * not hold is the object's own lookup; a set is the key's and the value's ToString (with DEP0104 once under
 * --pending-deprecation, for a value that is not a string, a number or a boolean); a delete always answers true; a
 * define takes only a configurable, writable, enumerable value.
 */
export function createEnvProxy(store: EnvStore, require: (id: string) => any): object {
  const invalid = (message: string): Error => {
    const { codes: { ERR_INVALID_OBJECT_DEFINE_PROPERTY } } = require('internal/errors') as { codes: Record<string, new (message: string) => Error> };
    return new ERR_INVALID_OBJECT_DEFINE_PROPERTY!(message);
  };
  let warned = false;
  /** EnvSetter (449-483). */
  const set = (key: string | symbol, value: unknown): boolean => {
    if (!warned && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'
      && (require('internal/options') as { getOptionValue(name: string): unknown }).getOptionValue('--pending-deprecation')) {
      warned = true;
      (require('internal/process/warning') as { emitWarning(message: string, type: string, code: string): void }).emitWarning(
        'Assigning any value other than a string, number, or boolean to a process.env property is deprecated. '
        + 'Please make sure to convert the value to a string before setting process.env with it.', 'DeprecationWarning', 'DEP0104');
    }
    const name = `${key as string}`;
    const text = `${value as string}`;
    store.set(name, text);
    return true;
  };
  return new Proxy({} as Record<string, string>, {
    // EnvGetter (427-447).
    get: (target, key, receiver) => {
      if (typeof key === 'symbol') return undefined;
      const value = store.get(key);
      return value !== undefined ? value : Reflect.get(target, key, receiver);
    },
    set: (_target, key, value) => set(key, value),
    // EnvQuery (485-500): attributes None where the store holds the name, else the object's own.
    has: (target, key) => (typeof key === 'string' && store.has(key)) || Reflect.has(target, key),
    getOwnPropertyDescriptor: (target, key) => {
      if (typeof key === 'string' && store.has(key)) {
        return { value: store.get(key), writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    // EnvDeleter (502-516): process.env has no non-configurable property, so a delete answers true.
    deleteProperty: (_target, key) => {
      if (typeof key === 'string') store.delete(key);
      return true;
    },
    // EnvEnumerator (518-528). A proxy's keys are distinct, where an environ can hold a name twice.
    ownKeys: () => [...new Set(store.keys())],
    // EnvDefiner (530-584).
    defineProperty: (_target, key, descriptor) => {
      if ('value' in descriptor) {
        if (descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true) {
          throw invalid("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
        }
        return set(key, descriptor.value);
      }
      if ('get' in descriptor || 'set' in descriptor) throw invalid("'process.env' does not accept an accessor(getter/setter) descriptor");
      throw invalid("'process.env' only accepts a configurable, writable, and enumerable data descriptor");
    },
  });
}
