/**
 * THE PROCESS'S `node` PROGRAM, AS THE BINDINGS REACH IT (ADR-0018 §3, item 6). On the machine a Node process is the
 * WALI program `node` (native/node), whose C holds each handle's and request's libuv struct in the process's memory.
 * The host gives the engine the program's exports and its memory's one door (a copy each way: a browser's APIs refuse
 * a view of shared memory) with `installLibnode`, and answers the program's `host:tabnode` imports that complete the
 * bindings' work with `libnodeImports()`. A binding over libuv is its V8 half: it writes a call's arguments into the
 * process's memory, calls the C, and reads the answer, as Node's C++ reads a uv_fs_t.
 */

/** A pointer, a size or an i32 as the program answers it. */
type I32 = number;

/** The exports of native/node's fs.c, fs_cp.c and fs_event.c, as WebAssembly hands them to JavaScript. */
export interface LibnodeExports {
  tabnode_fs_new(room: I32): I32;
  tabnode_fs_room(request: I32): I32;
  tabnode_fs_free(request: I32): void;
  tabnode_fs_result(request: I32): number;
  tabnode_fs_path(request: I32): I32;
  tabnode_fs_ptr(request: I32): I32;
  tabnode_fs_first_path(request: I32): I32;
  tabnode_fs_data(request: I32): I32;
  tabnode_fs_data_length(request: I32): I32;
  tabnode_fs_stat_fields(): I32;
  tabnode_fs_bigint_stat_fields(): I32;
  tabnode_fs_statfs_fields(): I32;
  tabnode_fs_bigint_statfs_fields(): I32;
  tabnode_fs_fill_request_stats(request: I32): void;
  tabnode_fs_fill_request_statfs(request: I32): void;
  tabnode_fs_error_kind(): I32;
  tabnode_fs_error_errno(): I32;
  tabnode_fs_error_syscall(): I32;
  tabnode_fs_error_code(): I32;
  tabnode_fs_error_message(): I32;
  tabnode_fs_error_path(): I32;
  tabnode_fs_error_dest(): I32;
  tabnode_uv_err_name(err: I32): I32;
  tabnode_uv_strerror(err: I32): I32;
  tabnode_strerror(errorno: I32): I32;
  tabnode_strlen(text: I32): I32;
  tabnode_fs_access(request: I32, path: I32, mode: I32, async: I32): I32;
  tabnode_fs_close(request: I32, fd: I32, async: I32): I32;
  tabnode_fs_open(request: I32, path: I32, flags: I32, mode: I32, async: I32): I32;
  tabnode_fs_read(request: I32, fd: I32, nbufs: I32, position: bigint, async: I32): I32;
  tabnode_fs_write(request: I32, fd: I32, nbufs: I32, position: bigint, async: I32): I32;
  tabnode_fs_stat(request: I32, path: I32, async: I32): I32;
  tabnode_fs_lstat(request: I32, path: I32, async: I32): I32;
  tabnode_fs_fstat(request: I32, fd: I32, async: I32): I32;
  tabnode_fs_statfs(request: I32, path: I32, async: I32): I32;
  tabnode_fs_symlink(request: I32, target: I32, path: I32, flags: I32, async: I32): I32;
  tabnode_fs_link(request: I32, src: I32, dest: I32, async: I32): I32;
  tabnode_fs_readlink(request: I32, path: I32, async: I32): I32;
  tabnode_fs_rename(request: I32, from: I32, to: I32, async: I32): I32;
  tabnode_fs_ftruncate(request: I32, fd: I32, length: bigint, async: I32): I32;
  tabnode_fs_fdatasync(request: I32, fd: I32, async: I32): I32;
  tabnode_fs_fsync(request: I32, fd: I32, async: I32): I32;
  tabnode_fs_unlink(request: I32, path: I32, async: I32): I32;
  tabnode_fs_rmdir(request: I32, path: I32, async: I32): I32;
  tabnode_fs_mkdir(request: I32, path: I32, mode: I32, async: I32): I32;
  tabnode_fs_mkdirp(request: I32, path: I32, mode: I32, async: I32): I32;
  tabnode_fs_realpath(request: I32, path: I32, async: I32): I32;
  tabnode_fs_scandir(request: I32, path: I32, async: I32): I32;
  tabnode_fs_scandir_next(request: I32): I32;
  tabnode_fs_scanned_name(): I32;
  tabnode_fs_scanned_type(): I32;
  tabnode_fs_copyfile(request: I32, src: I32, dest: I32, flags: I32, async: I32): I32;
  tabnode_fs_chmod(request: I32, path: I32, mode: I32, async: I32): I32;
  tabnode_fs_fchmod(request: I32, fd: I32, mode: I32, async: I32): I32;
  tabnode_fs_chown(request: I32, path: I32, uid: I32, gid: I32, async: I32): I32;
  tabnode_fs_fchown(request: I32, fd: I32, uid: I32, gid: I32, async: I32): I32;
  tabnode_fs_lchown(request: I32, path: I32, uid: I32, gid: I32, async: I32): I32;
  tabnode_fs_utime(request: I32, path: I32, atime: number, mtime: number, async: I32): I32;
  tabnode_fs_futime(request: I32, fd: I32, atime: number, mtime: number, async: I32): I32;
  tabnode_fs_lutime(request: I32, path: I32, atime: number, mtime: number, async: I32): I32;
  tabnode_fs_mkdtemp(request: I32, template: I32, async: I32): I32;
  tabnode_fs_read_file_utf8(request: I32, path: I32, fd: I32, flags: I32): I32;
  tabnode_fs_write_file_utf8(request: I32, path: I32, fd: I32, flags: I32, mode: I32, data: I32, length: I32): I32;
  tabnode_fs_rm_sync(path: I32, maxRetries: I32, recursive: I32, retryDelay: I32): I32;
  tabnode_fs_cp_check_paths(src: I32, dest: I32, dereference: I32, recursive: I32): I32;
  tabnode_fs_cp_override_file(src: I32, dest: I32, mode: I32, preserveTimestamps: I32): I32;
  tabnode_fs_cp_copy_dir(src: I32, dest: I32, force: I32, dereference: I32, errorOnExist: I32, verbatimSymlinks: I32,
    preserveTimestamps: I32): I32;
  tabnode_fs_opendir(request: I32, path: I32, async: I32): I32;
  tabnode_fs_dir_adopt(dir: I32): void;
  tabnode_fs_readdir(request: I32, dir: I32, entries: I32, async: I32): I32;
  tabnode_fs_dir_entry_name(dir: I32, index: I32): I32;
  tabnode_fs_dir_entry_type(dir: I32, index: I32): I32;
  tabnode_fs_closedir(request: I32, dir: I32, async: I32): I32;
  tabnode_fs_event_new(): I32;
  tabnode_fs_event_init(handle: I32): I32;
  tabnode_fs_event_start(handle: I32, path: I32, flags: I32): I32;
  tabnode_stat_watcher_new(): I32;
  tabnode_stat_watcher_start(handle: I32, path: I32, interval: I32): I32;
  tabnode_handle_close(handle: I32): void;
  tabnode_handle_ref(handle: I32, ref: I32): void;
  tabnode_handle_has_ref(handle: I32): I32;
  tabnode_handle_is_active(handle: I32): I32;
}

/** The process's memory, as the host's door answers it: a copy of `length` bytes at `at`, and a write of `bytes`. */
export interface LibnodeMemory {
  read(at: number, length: number): Uint8Array;
  write(at: number, bytes: Uint8Array): void;
}

/** The program, once the host has said it. */
export interface Libnode extends LibnodeMemory {
  readonly exports: LibnodeExports;
  /** The NUL-terminated bytes at a pointer (none for NULL). */
  cBytes(pointer: number): Uint8Array | null;
  /** The same, decoded as UTF-8, as V8's String::NewFromUtf8 decodes it. */
  cString(pointer: number): string | null;
}

// eslint-disable-next-line no-var, vars-on-top
var installed: { program: () => object; memory: LibnodeMemory } | null = null;

/**
 * The host's `node` program: `program()` answers its exports once it is instantiated (a Node process's exports are
 * known only after its imports, which this module answers, are made), `memory` its process's memory. Given once, by
 * the host that runs the process, before Node's library runs; a realm a host gives none runs its bindings over the
 * engine's own tree (fs.ts).
 */
export function installLibnode(program: () => object, memory: LibnodeMemory): void {
  installed = { program, memory };
}

/** Whether this realm is a process whose program is `node` over libuv. */
export function libnodeInstalled(): boolean { return installed !== null; }

const utf8 = new TextDecoder();

/** The program: its exports and its memory. Only a realm with `installLibnode` has one. */
export function libnode(): Libnode {
  if (!installed) throw Object.assign(new Error('libnode: this realm runs no `node` program'), { code: 'ENOSYS' });
  const { program, memory } = installed;
  const exports = program() as LibnodeExports;
  const cBytes = (pointer: number): Uint8Array | null => {
    const at = pointer >>> 0;
    if (at === 0) return null;
    return memory.read(at, exports.tabnode_strlen(at) >>> 0);
  };
  return {
    exports,
    read: memory.read,
    write: memory.write,
    cBytes,
    cString: (pointer) => { const bytes = cBytes(pointer); return bytes === null ? null : utf8.decode(bytes); },
  };
}

/** What a binding answers for a completion the program reports, keyed by the pointer of its request or handle. */
export interface LibnodeHandleEvents {
  fsEvent?(filename: number, events: number, status: number): void;
  statWatcherChange?(status: number): void;
  closed?(): void;
}
const requests = new Map<number, () => void>();
const handles = new Map<number, LibnodeHandleEvents>();

/** A request's completion (`fs_done`), until it arrives. */
export function awaitRequest(request: number, done: () => void): void { requests.set(request >>> 0, done); }
/** A handle's callbacks, until its close arrives. */
export function listenHandle(handle: number, events: LibnodeHandleEvents): void { handles.set(handle >>> 0, events); }

/**
 * The program's `host:tabnode` imports a binding over libuv answers (native/node engine.h): each runs what Node's C++
 * runs in V8 at that point, and the C closes the callback's scope after it (`drain`). The host merges these into the
 * imports it answers for the program.
 */
export function libnodeImports(): Record<string, (...args: number[]) => void> {
  return {
    fs_done: (request: number) => {
      const at = request >>> 0;
      const done = requests.get(at);
      requests.delete(at);
      done?.();
    },
    fs_event: (handle: number, filename: number, events: number, status: number) => {
      handles.get(handle >>> 0)?.fsEvent?.(filename, events, status);
    },
    stat_watcher_change: (handle: number, status: number) => {
      handles.get(handle >>> 0)?.statWatcherChange?.(status);
    },
    handle_closed: (handle: number) => {
      const at = handle >>> 0;
      const events = handles.get(at);
      handles.delete(at);
      events?.closed?.();
    },
  };
}
