/**
 * SQLite's own WebAssembly build (`sqlite3.wasm` from @sqlite.org/sqlite-wasm), instantiated synchronously and called
 * through its C API, for `node:sqlite` (./sqlite.ts).
 *
 * Node's `node:sqlite` is synchronous, and `require('node:sqlite')` with a `new DatabaseSync()` beside it at a module's
 * top is how programs use it, so SQLite must be ready the moment it is asked for. The package's JavaScript glue starts
 * SQLite through promises; its WebAssembly module itself needs nothing asynchronous. So the module is compiled and
 * instantiated here synchronously (a worker may), with the imports SQLite calls for an in-memory database: the clock,
 * the time zone, the heap's growth and stderr. The file syscalls its unix VFS imports answer ENOSYS: this engine's
 * databases are in-memory ones whose bytes ./sqlite.ts reads and writes.
 *
 * Where the bytes come from: `globalThis.__substrateSqliteWasm` (a WebAssembly.Module or its bytes) where the host put
 * it, else `globalThis.__substrateSqliteWasmUrl`, read synchronously (a worker's synchronous request), else, on a Node
 * host, the package installed beside the engine.
 */

const ENOSYS = 52;

export interface SqliteC {
  exports: Record<string, (...args: any[]) => any>;
  memory: WebAssembly.Memory;
  /** A NUL-terminated UTF-8 string allocated with sqlite3_malloc; the caller frees it. */
  cString(text: string): number;
  /** A UTF-8 string at `pointer`, read up to its NUL, or null for a null pointer. */
  string(pointer: number): string | null;
  bytes(pointer: number, length: number): Uint8Array;
  /** `bytes` copied into memory allocated with sqlite3_malloc64. */
  alloc(bytes: Uint8Array): number;
  /** A pointer-sized scratch cell, freed by `free`. */
  cell(size?: number): number;
  free(pointer: number): void;
}

let instance: SqliteC | undefined;

function wasmBytes(): WebAssembly.Module | Uint8Array {
  const given = (globalThis as { __substrateSqliteWasm?: WebAssembly.Module | Uint8Array | ArrayBuffer }).__substrateSqliteWasm;
  if (given instanceof WebAssembly.Module || given instanceof Uint8Array) return given;
  if (given instanceof ArrayBuffer) return new Uint8Array(given);
  const url = (globalThis as { __substrateSqliteWasmUrl?: string }).__substrateSqliteWasmUrl;
  if (url && typeof XMLHttpRequest === 'function') {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType?.('text/plain; charset=x-user-defined');
    request.send();
    if (request.status >= 200 && request.status < 300) {
      const text = request.responseText;
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
      return bytes;
    }
  }
  const host = typeof process !== 'undefined' ? (process as unknown as { getBuiltinModule?: (name: string) => any }).getBuiltinModule : undefined;
  if (typeof host === 'function') {
    try {
      const { createRequire } = host('module');
      const { readFileSync } = host('fs');
      const { dirname, join } = host('path');
      const entry = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm');
      return new Uint8Array(readFileSync(join(dirname(entry), 'sqlite3.wasm')));
    } catch { /* not installed beside the engine */ }
  }
  throw Object.assign(new Error('No such built-in module: node:sqlite (this realm holds no SQLite build)'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
}

/** SQLite, instantiated once per realm at its first use. */
export function sqliteC(): SqliteC {
  if (instance) return instance;
  const source = wasmBytes();
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source as Uint8Array<ArrayBuffer>);
  const memory = new WebAssembly.Memory({ initial: 8388608 / 65536, maximum: 32768 });
  const view = (): DataView => new DataView(memory.buffer);
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const enosys = () => -ENOSYS;
  const env: Record<string, unknown> = {
    memory,
    emscripten_date_now: () => Date.now(),
    emscripten_get_now: () => performance.now(),
    emscripten_get_heap_max: () => 2147483648,
    emscripten_resize_heap: (requested: number) => {
      requested >>>= 0;
      const current = memory.buffer.byteLength;
      if (requested > 2147483648) return 0;
      const target = Math.min(2147483648, Math.max(requested, Math.ceil(current * 1.2)));
      try { memory.grow(Math.ceil((target - current) / 65536)); return 1; } catch { return 0; }
    },
    // No zone names or offsets of the guest's own: UTC, as SQLite's date functions read 'localtime' then.
    _tzset_js: (timezone: number, daylight: number, stdName: number, dstName: number) => {
      const v = view();
      v.setInt32(timezone, 0, true); v.setInt32(daylight, 0, true);
      for (const at of [stdName, dstName]) { const name = encoder.encode('UTC\0'); new Uint8Array(memory.buffer, at, name.length).set(name); }
    },
    _localtime_js: (time: bigint, pointer: number) => {
      const date = new Date(Number(time) * 1000);
      const v = view();
      const fields = [date.getUTCSeconds(), date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth(), date.getUTCFullYear() - 1900, date.getUTCDay()];
      fields.forEach((value, index) => v.setInt32(pointer + index * 4, value, true));
      const start = Date.UTC(date.getUTCFullYear(), 0, 1);
      v.setInt32(pointer + 28, Math.floor((date.getTime() - start) / 86400000), true);
      v.setInt32(pointer + 32, 0, true);
      v.setInt32(pointer + 36, 0, true);
    },
    _mmap_js: enosys, _munmap_js: enosys,
  };
  for (const name of ['__syscall_faccessat', '__syscall_fchmod', '__syscall_chmod', '__syscall_fchown32', '__syscall_fcntl64', '__syscall_openat',
    '__syscall_ioctl', '__syscall_fstat64', '__syscall_stat64', '__syscall_newfstatat', '__syscall_lstat64', '__syscall_ftruncate64', '__syscall_getcwd',
    '__syscall_mkdirat', '__syscall_readlinkat', '__syscall_rmdir', '__syscall_unlinkat', '__syscall_utimensat']) env[name] = enosys;
  const wasi: Record<string, unknown> = {
    fd_close: () => ENOSYS, fd_read: () => ENOSYS, fd_seek: () => ENOSYS, fd_sync: () => 0, fd_fdstat_get: () => ENOSYS,
    // SQLite writes to stderr only for its own diagnostics: said on the realm's console.
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      const v = view();
      let total = 0, text = '';
      for (let i = 0; i < count; i++) {
        const base = v.getUint32(iovs + i * 8, true), length = v.getUint32(iovs + i * 8 + 4, true);
        text += decoder.decode(new Uint8Array(memory.buffer, base, length)); total += length;
      }
      if (fd === 2 && text.trim()) console.warn(`[node:sqlite] ${text.trim()}`);
      v.setUint32(written, total, true);
      return 0;
    },
    environ_sizes_get: (count: number, size: number) => { const v = view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_id: number, _precision: bigint, out: number) => { view().setBigInt64(out, BigInt(Math.round(Date.now() * 1e6)), true); return 0; },
  };
  const exports = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: wasi } as unknown as WebAssembly.Imports).exports as Record<string, (...args: any[]) => any>;
  exports.__wasm_call_ctors?.();
  const rc = exports.sqlite3_initialize();
  if (rc !== 0) throw Object.assign(new Error(`SQLite did not initialize (${rc})`), { code: 'ERR_SQLITE_ERROR' });
  instance = {
    exports, memory,
    cString(text) {
      const bytes = encoder.encode(text);
      const pointer = exports.sqlite3_malloc(bytes.length + 1) as number;
      const target = new Uint8Array(memory.buffer, pointer, bytes.length + 1);
      target.set(bytes); target[bytes.length] = 0;
      return pointer;
    },
    string(pointer) {
      if (!pointer) return null;
      const heap = new Uint8Array(memory.buffer);
      let end = pointer;
      while (heap[end] !== 0) end++;
      return decoder.decode(heap.subarray(pointer, end));
    },
    bytes(pointer, length) { return new Uint8Array(memory.buffer, pointer, length).slice(); },
    alloc(bytes) {
      const pointer = Number(exports.sqlite3_malloc64(BigInt(Math.max(1, bytes.length))));
      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
      return pointer;
    },
    cell(size = 8) {
      const pointer = exports.sqlite3_malloc(size) as number;
      new Uint8Array(memory.buffer, pointer, size).fill(0);
      return pointer;
    },
    free(pointer) { if (pointer) exports.sqlite3_free(pointer); },
  };
  return instance;
}
