/**
 * THE PROCESS'S `node` PROGRAM, AS THE BINDINGS REACH IT (ADR-0018 §2, §3, §4). On the machine a Node process is the
 * WALI program `node`, whose C (Tabnode's `native/node`, over libuv in `libnode.so`) is the libuv half of each
 * binding, as Node's `src/*_wrap.cc` and `src/node_file.cc` are: every handle a binding makes is a uv_handle_t in the
 * process's memory (`handle_wrap.ts`), every request its uv_req_t, and a binding's JavaScript calls the program's
 * exports. libuv's callbacks reach the bindings as the engine's imports (`native/node/engine.h`), which
 * `libnodeImports` answers, each followed in C by a drain, as Node's MakeCallback is followed by its
 * InternalCallbackScope's close.
 *
 * The host that runs the program attaches it once, in its `bootstrap` import, before Node's library runs
 * (`attachLibnode`): the program's exports, and the process's memory through its one door, a copy read and bytes
 * written, since a browser's APIs refuse a view of shared memory. The run's end is libuv's (ADR-0018 item 7): `main`
 * spins the loop as Node's SpinEventLoopInternal does and asks the process's run, which gives its end once
 * (`attachLibnodeRun`), for `beforeExit`, `exit` and the code it returns; `process.exit` is the program's exit
 * (`reallyExit`). A realm the host gives no program (a tab's engine
 * with no machine) has no libuv: its streams are the engine's pairing and its fs the engine's own tree (`fs.ts`), and
 * a binding that is only libuv's (`process_wrap`, `spawn_sync`, `signal_wrap`) answers that it has none. A binding
 * over libuv is its V8 half: it writes a call's arguments into the process's memory, calls the C, and reads the answer,
 * as Node's C++ reads a uv_fs_t. The crypto and tls_wrap bindings are the same over OpenSSL in libnode.so
 * (`openssl.ts`), and what OpenSSL raises inside one of their calls comes back as the `tls_*` imports, inside that call.
 */
import { errname, getErrorMessage } from './uv';
import { drainGuestNextTicks, withGuestExecution } from '../../guest-loop';

/** A pointer, a size or an i32 as the program answers it. */
type I32 = number;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What native/node exports to the bindings, by its C names; each is named for the Node function it carries. */
export interface LibnodeExports {
  /** memory.c: the allocator a call's record and a request's bytes are made and freed with. */
  tabnode_malloc(size: I32): I32;
  tabnode_free(at: I32): void;
  /** handle_wrap.c: HandleWrap's calls on its uv_handle_t, and what every binding's glue shares. */
  tabnode_handle_close(handle: I32): void;
  tabnode_handle_ref(handle: I32): void;
  tabnode_handle_unref(handle: I32): void;
  tabnode_handle_has_ref(handle: I32): I32;
  tabnode_handle_is_active(handle: I32): I32;
  tabnode_handle_fileno(handle: I32): I32;
  tabnode_guess_handle(fd: I32): I32;
  tabnode_pipe_pending_type(handle: I32): I32;
  /** stream_wrap.c: LibuvStreamWrap, StreamBase's libuv half and ConnectionWrap. */
  tabnode_stream_read_start(handle: I32): I32;
  tabnode_stream_read_stop(handle: I32): I32;
  tabnode_stream_use_buffer(handle: I32, length: I32): void;
  tabnode_stream_write(handle: I32, id: I32, bytes: I32, length: I32, sendHandle: I32): I32;
  tabnode_stream_shutdown(handle: I32, id: I32): I32;
  tabnode_stream_write_queue_size(handle: I32): I32;
  tabnode_stream_set_blocking(handle: I32, blocking: I32): I32;
  tabnode_stream_listen(handle: I32, backlog: I32): I32;
  tabnode_stream_accept(server: I32, client: I32): I32;
  /** tcp_wrap.c: TCPWrap's. */
  tabnode_tcp_init(): I32;
  tabnode_tcp_open(handle: I32, fd: I32): I32;
  tabnode_tcp_bind(handle: I32, family: I32, ip: I32, port: I32, flags: I32): I32;
  tabnode_tcp_connect(handle: I32, id: I32, family: I32, ip: I32, port: I32): I32;
  tabnode_tcp_name(handle: I32, peer: I32, out: I32): I32;
  tabnode_tcp_nodelay(handle: I32, enable: I32): I32;
  tabnode_tcp_keepalive(handle: I32, enable: I32, delay: I32, interval: I32, count: I32): I32;
  tabnode_tcp_set_tos(handle: I32, tos: I32): I32;
  tabnode_tcp_get_tos(handle: I32): I32;
  tabnode_tcp_reset(handle: I32): I32;
  /** pipe_wrap.c: PipeWrap's. */
  tabnode_pipe_init(ipc: I32): I32;
  tabnode_pipe_bind(handle: I32, name: I32, length: I32): I32;
  tabnode_pipe_open(handle: I32, fd: I32): I32;
  tabnode_pipe_connect(handle: I32, id: I32, name: I32, length: I32): I32;
  tabnode_pipe_chmod(handle: I32, mode: I32): I32;
  /** tty_wrap.c: TTYWrap's. */
  tabnode_tty_new(): I32;
  tabnode_tty_init(handle: I32, fd: I32): I32;
  tabnode_tty_get_winsize(handle: I32, out: I32): I32;
  tabnode_tty_set_mode(handle: I32, mode: I32): I32;
  /** udp_wrap.c: UDPWrap's. */
  tabnode_udp_init(): I32;
  tabnode_udp_open(handle: I32, fd: I32): I32;
  tabnode_udp_bind(handle: I32, family: I32, ip: I32, port: I32, flags: I32): I32;
  tabnode_udp_connect(handle: I32, family: I32, ip: I32, port: I32): I32;
  tabnode_udp_disconnect(handle: I32): I32;
  tabnode_udp_send(handle: I32, id: I32, bytes: I32, length: I32, family: I32, ip: I32, port: I32): I32;
  tabnode_udp_recv_start(handle: I32): I32;
  tabnode_udp_recv_stop(handle: I32): I32;
  tabnode_udp_name(handle: I32, peer: I32, out: I32): I32;
  tabnode_udp_membership(handle: I32, address: I32, iface: I32, join: I32): I32;
  tabnode_udp_source_membership(handle: I32, source: I32, group: I32, iface: I32, join: I32): I32;
  tabnode_udp_multicast_interface(handle: I32, iface: I32): I32;
  tabnode_udp_set_int(handle: I32, which: I32, value: I32): I32;
  tabnode_udp_buffer_size(handle: I32, size: I32, isRecv: I32): I32;
  tabnode_udp_send_queue_size(handle: I32): number;
  tabnode_udp_send_queue_count(handle: I32): number;
  /** process_wrap.c: ProcessWrap's. */
  tabnode_process_new(): I32;
  tabnode_process_spawn(process: I32, options: I32): I32;
  tabnode_process_pid(process: I32): I32;
  tabnode_process_kill(process: I32, signal: I32): I32;
  /** signal_wrap.c: SignalWrap's. */
  tabnode_signal_new(): I32;
  tabnode_signal_start(handle: I32, signum: I32): I32;
  tabnode_signal_stop(handle: I32): I32;
  /** node_messaging.c: MessagePort's uv_async_t and its TriggerAsync. */
  tabnode_message_port_new(): I32;
  tabnode_message_port_trigger(handle: I32): void;
  /** process_methods.c: process._kill's uv_kill. */
  tabnode_kill(pid: I32, signal: I32): I32;
  /** uv.c: uv.cc's error table (12 bytes an entry, its count at `countAt`), ErrName and GetErrMessage into 50 bytes. */
  tabnode_uv_errors(countAt: I32): I32;
  tabnode_uv_err_name_r(err: I32, name: I32): void;
  tabnode_uv_strerror_r(err: I32, message: I32): void;
  /** node_constants.cc: Node's constants as the program compiled them, its text malloc'd, its length at `lengthAt`. */
  tabnode_constants(lengthAt: I32): I32;
  /** spawn_sync.c: SyncProcessRunner's run, and its result's release. */
  tabnode_spawn_sync(options: I32): I32;
  tabnode_spawn_sync_free(result: I32): void;
  /** fs.c, fs_cp.c and fs_event.c: node_file.cc's, node_dir.cc's, fs_event_wrap.cc's and node_stat_watcher.cc's. */
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
  tabnode_fs_internal_module_stat(request: I32, path: I32): I32;
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
  tabnode_fs_event_start(handle: I32, path: I32, recursive: I32): I32;
  tabnode_stat_watcher_new(): I32;
  tabnode_stat_watcher_start(handle: I32, path: I32, interval: I32): I32;
  /** stdio.c: exit(3), which runs Node's ResetStdio and ends the process: `process.reallyExit`'s. */
  tabnode_exit(status: I32): void;
}

/** The program as its host gives it: its exports once instantiated, and the process's memory's one door. */
export interface LibnodeProgram {
  readonly exports: LibnodeExports;
  /** A copy of `length` bytes of the process's memory at `at`. */
  read(at: number, length: number): Uint8Array;
  /** `bytes` into the process's memory at `at`. */
  write(at: number, bytes: Uint8Array): void;
}

/** The program as the bindings reach it: the host's, and a C string's bytes read through its door. */
export interface Libnode extends LibnodeProgram {
  /** The NUL-terminated bytes at a pointer (none for NULL). */
  cBytes(pointer: number): Uint8Array | null;
  /** The same, decoded as UTF-8, as V8's String::NewFromUtf8 decodes it. */
  cString(pointer: number): string | null;
}

let given: LibnodeProgram | undefined;
let attached: Libnode | undefined;

/** The realm's process is `node` on libuv's loop: its program, given once by the host's `bootstrap`. */
export function attachLibnode(program: LibnodeProgram): void {
  if (given && given !== program) throw new Error('the realm already has its process\'s node program');
  if (given) return;
  given = program;
  const { exports, read, write } = program;
  const cBytes = (pointer: number): Uint8Array | null => {
    const at = address(pointer);
    if (at === 0) return null;
    return read(at, address(exports.tabnode_strlen(at)));
  };
  attached = {
    exports, read, write, cBytes,
    cString: (pointer) => { const bytes = cBytes(pointer); return bytes === null ? null : decoder.decode(bytes); },
  };
}

/**
 * The run's end as `main` asks it (ADR-0018 item 7; native/node engine.h), what Node's C++ does once `uv_run` returns
 * (src/api/embed_helpers.cc:40-76): `beforeExit` (EmitProcessBeforeExit, src/api/hooks.cc:33-51), 0 or nonzero where
 * its emission failed; `emitExit` (EmitProcessExitInternal, hooks.cc:61-93); and `exitCode`, the code `main` returns.
 */
export interface LibnodeRunEnd {
  beforeExit(): number;
  emitExit(): void;
  exitCode(): number;
}

let runEnd: LibnodeRunEnd | undefined;

/** The realm's process gives its end once, before its first callback (`launchNode`). */
export function attachLibnodeRun(end: LibnodeRunEnd): void {
  if (runEnd) throw new Error('the realm\'s node program already has its process');
  runEnd = end;
}

/** The process `main` ends: none where libuv's loop emptied before the run made it. */
function theRunEnd(): LibnodeRunEnd {
  if (!runEnd) throw new Error('node: libuv\'s loop ended before the run made its process');
  return runEnd;
}

/**
 * Node's `process.reallyExit` (src/node_process_methods.cc:502-511): its argument's Int32Value, kNoFailure where that
 * throws, then exit(3), from inside whatever callback calls it.
 */
export function reallyExit(code: unknown): void {
  let status = 0;
  try { status = (code as number) | 0; } catch { /* Int32Value's Nothing: kNoFailure */ }
  libnode().exports.tabnode_exit(status);
}

/** Whether the realm's process is the program `node`, whose bindings are libuv's. */
export function libnodeAttached(): boolean { return attached !== undefined; }

/** The program a binding calls: refused where the realm has none, since a binding over libuv is its C. */
export function libnode(): Libnode {
  if (!attached) throw new Error('this realm has no node program: its bindings over libuv are the program\'s C (ADR-0018 §3)');
  return attached;
}

/** A wasm32 address as the program answers it (an i32, negative from 2 GiB), as an offset. */
export function address(value: number): number {
  return value >>> 0;
}

/** `bytes` copied into room the call they are handed to owns (a write's, a send's): the room's address. */
export function intoMemory(bytes: Uint8Array): number {
  const { exports, write } = libnode();
  const at = address(exports.tabnode_malloc(bytes.byteLength));
  if (bytes.byteLength) write(at, bytes);
  return at;
}

/** A copy of `length` bytes of the process's memory at `at`, an ArrayBuffer of its own. */
export function fromMemory(at: number, length: number): ArrayBuffer {
  const bytes = libnode().read(address(at), length);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

/** A record of `length` bytes at `at`, read whole once: its fields at offsets from 0. */
export function readRecord(at: number, length: number): DataView {
  const bytes = libnode().read(address(at), length);
  return new DataView(bytes.buffer, bytes.byteOffset, length);
}

/**
 * `text` as Node's Utf8Value makes it (its UTF-8, NUL-terminated) in the process's memory for the length of `call`,
 * which is given its address and its length without the NUL; null text is a NULL pointer.
 */
export function withCString<T>(text: string | null, call: (at: number, length: number) => T): T {
  if (text === null) return call(0, 0);
  const bytes = encoder.encode(text);
  const room = new Uint8Array(bytes.byteLength + 1);
  room.set(bytes);
  const at = intoMemory(room);
  try { return call(at, bytes.byteLength); } finally { libnode().exports.tabnode_free(at); }
}

/** Room of `size` bytes for a call's out-parameters, read back as a DataView, for the length of `call`. */
export function withRoom<T>(size: number, call: (at: number) => T, read: (view: DataView, answer: T) => void): T {
  const program = libnode();
  const at = address(program.exports.tabnode_malloc(size));
  try {
    const answer = call(at);
    const bytes = program.read(at, size);
    read(new DataView(bytes.buffer, bytes.byteOffset, size), answer);
    return answer;
  } finally { program.exports.tabnode_free(at); }
}

/**
 * One record laid out for the C from a call's JavaScript values, as Node's C++ reads them into C (a Utf8Value, a
 * std::vector<char*> of them, a uv_buf_t over a Buffer's bytes): its fixed fields at the offsets the C struct
 * declares (and asserts, `_Static_assert`), and what they point to after them. It is written into the process's
 * memory in one piece, and freed in one piece once the call returns (`commit`, `free`).
 */
export class CRecord {
  private bytes: Uint8Array;
  private view: DataView;
  private size: number;
  /** Each pointer field: its offset, and the offset in this record it points to. */
  private readonly pointers: { slot: number; target: number }[] = [];
  private at = 0;

  /** A record whose fixed fields are its first `fixed` bytes, zero. */
  constructor(fixed: number) {
    this.bytes = new Uint8Array(Math.max(256, fixed * 2));
    this.view = new DataView(this.bytes.buffer);
    this.size = fixed;
  }

  /** Room for `length` bytes after what is laid out, at a multiple of `alignment`: its offset. */
  room(length: number, alignment = 4): number {
    const offset = Math.ceil(this.size / alignment) * alignment;
    const end = offset + length;
    if (end > this.bytes.byteLength) {
      const grown = new Uint8Array(Math.max(end, this.bytes.byteLength * 2));
      grown.set(this.bytes.subarray(0, this.size));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.size = end;
    return offset;
  }

  int32(offset: number, value: number): void { this.view.setInt32(offset, value, true); }
  uint32(offset: number, value: number): void { this.view.setUint32(offset, value >>> 0, true); }
  float64(offset: number, value: number): void { this.view.setFloat64(offset, value, true); }

  /** The pointer field at `slot` points to `target`, an offset in this record (null: NULL). */
  pointer(slot: number, target: number | null): void {
    if (target === null) this.view.setUint32(slot, 0, true);
    else this.pointers.push({ slot, target });
  }

  /** `bytes`, copied in: their offset. */
  data(bytes: Uint8Array): number {
    const offset = this.room(bytes.byteLength, 1);
    this.bytes.set(bytes, offset);
    return offset;
  }

  /** A string as Node's Utf8Value makes it (UTF-8, a lone surrogate as U+FFFD), with its NUL: its offset. */
  string(text: string): number {
    const encoded = encoder.encode(text);
    const offset = this.room(encoded.byteLength + 1, 1);
    this.bytes.set(encoded, offset);
    this.bytes[offset + encoded.byteLength] = 0;
    return offset;
  }

  /** A NULL-terminated array of strings, as a `char **`: its offset. */
  strings(list: readonly string[]): number {
    const array = this.room((list.length + 1) * 4, 4);
    list.forEach((text, index) => { this.pointer(array + index * 4, this.string(text)); });
    this.uint32(array + list.length * 4, 0);
    return array;
  }

  /** The record written into the process's memory: its address, which `free` gives back. */
  commit(): number {
    const program = libnode();
    const at = address(program.exports.tabnode_malloc(this.size));
    for (const { slot, target } of this.pointers) this.view.setUint32(slot, at + target, true);
    program.write(at, this.bytes.slice(0, this.size));
    this.at = at;
    return at;
  }

  /** The record's memory, given back once the call that read it has returned. */
  free(): void {
    if (this.at !== 0) libnode().exports.tabnode_free(this.at);
    this.at = 0;
  }
}

/** native/node wrap.h `tabnode_address_t`: family, port, error, then the address's text; room enough for it. */
const ADDRESS_BYTES = 128;
const ADDRESS_TEXT = 12;

/** AddressToJS's fields, as a name call or a received datagram fills them. */
export interface AddressFields { address: string; family?: string; port?: number }

/** A filled `tabnode_address_t`, read as AddressToJS writes its object; uv_if_indextoiid's failure is thrown. */
export function readAddress(view: DataView): AddressFields {
  const family = view.getInt32(0, true), port = view.getInt32(4, true), error = view.getInt32(8, true);
  if (error !== 0) throw uvException(error, 'uv_if_indextoiid');
  let end = ADDRESS_TEXT;
  while (end < view.byteLength && view.getUint8(end) !== 0) end += 1;
  const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + ADDRESS_TEXT, end - ADDRESS_TEXT));
  if (family === 4) return { address: text, family: 'IPv4', port };
  if (family === 6) return { address: text, family: 'IPv6', port };
  return { address: '' };
}

/** GetSockOrPeerName (src/node_internals.h:70-83): `call` fills a name; on success AddressToJS sets it on `out`. */
export function sockOrPeerName(call: (out: number) => number, out: Record<string, unknown>): number {
  return withRoom(ADDRESS_BYTES, call, (view, err) => { if (err === 0) Object.assign(out, readAddress(view)); });
}

/** The process's memory at `at` read as a filled `tabnode_address_t`. */
export function addressAt(at: number): AddressFields {
  return readAddress(readRecord(at, ADDRESS_BYTES));
}

/**
 * Node's UVException: an Error with the error's errno, code and syscall, as `env->ThrowUVException` makes it, its code
 * uv_err_name's and its message uv_strerror's.
 */
export function uvException(err: number, syscall: string): Error {
  const code = errname(err), message = getErrorMessage(err);
  return Object.assign(new Error(`${syscall}: ${message}`), { errno: err, code, syscall });
}

/** Environment::CollectUVExceptionInfo: the error's fields on the binding's context object. */
export function collectUVExceptionInfo(ctx: unknown, err: number, syscall: string): void {
  if (ctx === null || typeof ctx !== 'object') return;
  const code = errname(err), message = getErrorMessage(err);
  Object.assign(ctx, { errno: err, code, message, syscall });
}

/** What a callback of libuv's on a handle reaches: the binding object the handle belongs to (Node's wrap). */
export interface HandleCallbacks {
  /** HandleWrap::OnClose's own part (the wrap's virtual OnClose): what the binding gives up beyond the handle. */
  onUvClose?(): void;
  /** LibuvStreamWrap::OnUvRead. */
  onUvRead?(nread: number, base: number): void;
  /** ConnectionWrap::OnConnection. */
  onUvConnection?(status: number): void;
  /** UDPWrap::OnRecv. */
  onUvRecv?(nread: number, base: number, name: number, flags: number): void;
  /** ProcessWrap::OnExit: the exit status, and the signal's name at `signal` (`length` bytes). */
  onUvExit?(exitStatus: number, signal: number, length: number): void;
  /** SignalWrap's uv_signal_cb: the signal's number. */
  onUvSignal?(signum: number): void;
  /** MessagePort::OnMessage's start: -1 for a detached port, else its processing limit. */
  onUvMessagePending?(): number;
  /** One turn of MessagePort::OnMessage's loop: 0 none emitted, 1 one emitted, 2 emitting failed. */
  onUvMessage?(): number;
  /** FSEventWrap::OnEvent: libuv's filename (a C string, 0 for none), the event's name the C chose, and the status. */
  onUvFsEvent?(filename: number, event: string, status: number): void;
  /** StatWatcher::Callback: the status, both stats in the binding's arrays. */
  onUvStatChange?(status: number): void;
}

/** An initialized handle, as libuv's callbacks find it by its address (Node's handle->data). */
export interface OpenHandle {
  readonly target: HandleCallbacks;
  /** HandleWrap::OnClose: answers whether it made the close callback. */
  closed(): boolean;
}

const handles = new Map<number, OpenHandle>();

/** An initialized handle at `at`, found by libuv's callbacks until it is closed (HandleWrap::MarkAsInitialized). */
export function openHandle(at: number, handle: OpenHandle): void { handles.set(address(at), handle); }
/** A closed handle: libuv calls nothing back on it again. */
export function forgetHandle(at: number): void { handles.delete(address(at)); }

/** The open handle at `at`, for a callback libuv makes only on an open handle. */
function handleAt(at: number): OpenHandle {
  const handle = handles.get(address(at));
  if (!handle) throw new Error(`node: libuv called back a handle no wrap holds (${address(at)})`);
  return handle;
}

/** Each stream's and socket's request in flight by the number its C struct carries (wrap.h `tabnode_req_t`). */
const requests = new Map<number, (status: number, ...rest: number[]) => void>();
let nextRequest = 1;

/** A request in flight: its completion, called once with libuv's status (and what AfterConnect adds). */
export function dispatchRequest(complete: (status: number, ...rest: number[]) => void): number {
  const id = nextRequest++;
  requests.set(id, complete);
  return id;
}
/** A request whose dispatch failed: no completion will come. */
export function forgetRequest(id: number): void { requests.delete(id); }

function complete(id: number, status: number, ...rest: number[]): void {
  const done = requests.get(id);
  if (!done) throw new Error(`node: libuv completed a request no wrap holds (${id})`);
  requests.delete(id);
  done(status, ...rest);
}

/** Each fs request in flight by its address (fs.h `tabnode_fs_t`, which begins with its uv_fs_t). */
const fsRequests = new Map<number, () => void>();

/** An fs request's completion (`fs_done`), until it arrives. */
export function awaitRequest(request: number, done: () => void): void { fsRequests.set(address(request), done); }

/** The engine's side of the TLS callbacks (engine.h `tls_*`), by the connection's TnSsl address. */
export interface TlsCallbacks {
  handshake(tls: number, done: number): void;
  keylog(tls: number, line: Uint8Array): void;
  newSession(tls: number, id: Uint8Array, der: Uint8Array): void;
  /** Answers 1 to continue the handshake, -1 to suspend it until `certCbDone`. */
  cert(tls: number, servername: string, ocsp: boolean): number;
  /** Answers the offset of the chosen protocol in `protocols`, or -1 (a fatal alert). */
  alpn(tls: number, protocols: Uint8Array): number;
}

let tls: TlsCallbacks | undefined;
/** The tls_wrap binding's callbacks, given once when it loads; OpenSSL raises them only for its connections. */
export function setTlsCallbacks(callbacks: TlsCallbacks): void { tls = callbacks; }

function tlsCallbacks(): TlsCallbacks {
  if (!tls) throw new Error('node: OpenSSL called back a connection no tls_wrap binding holds');
  return tls;
}

/** The crypto binding's side of its imports (engine.h `crypto_job_done`, `engine_ready`; ADR-0018 §5, item 7). */
export interface CryptoCallbacks {
  /** A CryptoJob's completion: answers nonzero where it made a callback. */
  jobDone(job: number, status: number): number;
  /** The engine device's descriptor is readable. */
  engineReady(status: number): void;
}

let crypto: CryptoCallbacks | undefined;
/** The crypto binding's callbacks, given once when it loads; libuv completes only the jobs it schedules. */
export function setCryptoCallbacks(callbacks: CryptoCallbacks): void { crypto = callbacks; }

function cryptoCallbacks(): CryptoCallbacks {
  if (!crypto) throw new Error('node: libuv completed crypto work no crypto binding holds');
  return crypto;
}

/**
 * The zlib and http_parser bindings' sides of their imports (engine.h `zlib_*`, `http_parser_*`; ADR-0018 item 10),
 * each given once when its binding loads: the C calls back only a stream or a parser its binding made.
 */
export interface ZlibCallbacks {
  zlib_error(stream: number, message: number, code: number, err: number): void;
  zlib_done(stream: number, written: number): void;
}
export interface HttpParserCallbacks {
  http_parser_has_callback(parser: number, index: number): number;
  http_parser_call(parser: number, index: number): number;
  http_parser_flush(parser: number): number;
  http_parser_headers_complete(parser: number, flushed: number, type: number, major: number, minor: number,
    method: number, statusCode: number, upgrade: number, shouldKeepAlive: number): number;
  http_parser_body(parser: number, at: number, length: number): number;
  http_parser_max_header_pairs(parser: number): number;
}

let zlibCallbacks: ZlibCallbacks | undefined;
let httpParserCallbacks: HttpParserCallbacks | undefined;
export function setZlibCallbacks(callbacks: ZlibCallbacks): void { zlibCallbacks = callbacks; }
export function setHttpParserCallbacks(callbacks: HttpParserCallbacks): void { httpParserCallbacks = callbacks; }

function zlibs(): ZlibCallbacks {
  if (!zlibCallbacks) throw new Error('node: zlib called back a stream no zlib binding holds');
  return zlibCallbacks;
}
function httpParsers(): HttpParserCallbacks {
  if (!httpParserCallbacks) throw new Error('node: llhttp called back a parser no http_parser binding holds');
  return httpParserCallbacks;
}

/**
 * The engine's imports the bindings answer (native/node engine.h), which the host puts among the program's
 * `host:tabnode` imports beside its own: each finds the handle by its address or the request by its number and calls
 * its JavaScript, as Node's C++ makes the callback with MakeCallback; the drain that closes the callback's scope is
 * the C's. The `tls_*` imports are OpenSSL's callbacks, made inside an SSL_* call the engine itself made, as Node's
 * are made inside SSL_read: no scope closes after them.
 */
export const libnodeImports = {
  /** The run's end, after `uv_run` returns (`LibnodeRunEnd`); each followed in C by a drain. */
  before_exit: (): number => theRunEnd().beforeExit(),
  emit_exit: (): void => { theRunEnd().emitExit(); },
  exit_code: (): number => theRunEnd().exitCode(),
  /** RunTimers' scope's ticks (env.cc:1563, closed at :1610), after the C has rescheduled the timer; then its drain. */
  close_scope: (): void => { withGuestExecution(drainGuestNextTicks, 'ticks'); },
  /** HandleWrap::OnClose: 1 where it made the close callback, whose scope the C closes; the C frees the handle. */
  handle_closed: (handle: number): number => (handleAt(handle).closed() ? 1 : 0),
  stream_read: (handle: number, nread: number, base: number): void => { handleAt(handle).target.onUvRead?.(nread, base); },
  stream_written: (id: number, status: number): void => { complete(id, status); },
  stream_shut: (id: number, status: number): void => { complete(id, status); },
  stream_connection: (handle: number, status: number): void => { handleAt(handle).target.onUvConnection?.(status); },
  stream_connected: (id: number, status: number, readable: number, writable: number): void => {
    complete(id, status, readable, writable);
  },
  udp_received: (handle: number, nread: number, base: number, name: number, flags: number): void => {
    handleAt(handle).target.onUvRecv?.(nread, base, name, flags);
  },
  udp_sent: (id: number, status: number): void => { complete(id, status); },
  /** ProcessWrap::OnExit: the handle's `onexit`. */
  process_exit: (handle: number, exitStatus: number, signal: number, length: number): void => {
    handleAt(handle).target.onUvExit?.(exitStatus, signal, length);
  },
  /** SignalWrap's uv_signal_cb: the handle's `onsignal`. */
  signal_received: (handle: number, signum: number): void => { handleAt(handle).target.onUvSignal?.(signum); },
  /** MessagePort::OnMessage over the port's uv_async_t: its processing limit, then each turn of its loop. */
  message_port_pending: (handle: number): number => handleAt(handle).target.onUvMessagePending?.() ?? -1,
  message_port_message: (handle: number): number => handleAt(handle).target.onUvMessage?.() ?? 0,
  /** An asynchronous uv_fs_* completed: the request's After and its MakeCallback, or its promise's settling. */
  fs_done: (request: number): void => {
    const at = address(request);
    const done = fsRequests.get(at);
    if (!done) throw new Error(`node: libuv completed an fs request no binding holds (${at})`);
    fsRequests.delete(at);
    done();
  },
  /** FSEventWrap::OnEvent. */
  fs_event: (handle: number, filename: number, event: number, status: number): void => {
    handleAt(handle).target.onUvFsEvent?.(filename, libnode().cString(event) ?? '', status);
  },
  /** StatWatcher::Callback. */
  stat_watcher_change: (handle: number, status: number): void => { handleAt(handle).target.onUvStatChange?.(status); },
  /** CryptoJob::AfterThreadPoolWork: 1 where it made the job's callback, whose scope the C closes; the C frees the job. */
  crypto_job_done: (job: number, status: number): number => cryptoCallbacks().jobDone(address(job), status),
  /** The engine device's answer waits (engine_device.c's uv_poll_t); the C drains after. */
  engine_ready: (status: number): void => { cryptoCallbacks().engineReady(status); },
  /** TLSWrap::SSLInfoCallback: a handshake began (0) or completed (1). Made inside the engine's own SSL_* call. */
  tls_handshake: (connection: number, done: number): void => { tlsCallbacks().handshake(address(connection), done); },
  /** KeylogCallback: one key log line. */
  tls_keylog: (connection: number, line: number, length: number): void => {
    tlsCallbacks().keylog(address(connection), libnode().read(address(line), address(length)));
  },
  /** NewSessionCallback: the session's id and DER. */
  tls_new_session: (connection: number, id: number, idLength: number, der: number, derLength: number): void => {
    const program = libnode();
    tlsCallbacks().newSession(address(connection), program.read(address(id), address(idLength)),
      program.read(address(der), address(derLength)));
  },
  /** SSLCertCallback: 1 continues the handshake, -1 suspends it. */
  tls_cert: (connection: number, servername: number, length: number, ocsp: number): number =>
    tlsCallbacks().cert(address(connection), decoder.decode(libnode().read(address(servername), address(length))), ocsp !== 0),
  /** SelectALPNCallback's JavaScript branch: the chosen protocol's offset, or -1. */
  tls_alpn: (connection: number, protocols: number, length: number): number =>
    tlsCallbacks().alpn(address(connection), libnode().read(address(protocols), address(length))),
  /** CompressionStream::EmitError's MakeCallback of `onerror`; on the loop, the C closes its scope. */
  zlib_error: (stream: number, message: number, code: number, err: number): void => {
    zlibs().zlib_error(stream, message, code, err);
  },
  /** AfterThreadPoolWork: the output, and with `written` the write result and the write callback, whose scope the C closes. */
  zlib_done: (stream: number, written: number): void => { zlibs().zlib_done(stream, written); },
  /** llhttp's callbacks into the parser's JavaScript, made inside the engine's own `execute`: no scope closes after them. */
  http_parser_has_callback: (parser: number, index: number): number => httpParsers().http_parser_has_callback(parser, index),
  http_parser_call: (parser: number, index: number): number => httpParsers().http_parser_call(parser, index),
  http_parser_flush: (parser: number): number => httpParsers().http_parser_flush(parser),
  http_parser_headers_complete: (parser: number, flushed: number, type: number, major: number, minor: number,
    method: number, statusCode: number, upgrade: number, shouldKeepAlive: number): number =>
    httpParsers().http_parser_headers_complete(parser, flushed, type, major, minor, method, statusCode, upgrade,
      shouldKeepAlive),
  http_parser_body: (parser: number, at: number, length: number): number => httpParsers().http_parser_body(parser, at, length),
  http_parser_max_header_pairs: (parser: number): number => httpParsers().http_parser_max_header_pairs(parser),
};
