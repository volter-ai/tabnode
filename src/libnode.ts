/**
 * THE PROGRAM `node`'S C, AS THE ENGINE'S BINDINGS REACH IT (ADR-0018 §2, §3). `/usr/bin/node` is a WALI program
 * whose C (Tabnode's native/node over libuv in `libnode.so`) is the libuv half of each binding, as Node's
 * `src/*_wrap.cc` is: a binding's JavaScript calls the program's exports, and the program's callbacks call the
 * engine's imports (`libnodeImports`, engine.h). The host that runs the program attaches it once, before Node's
 * library runs (`attachLibnode`): its exports, and the process's memory through its one door, a copy read and bytes
 * written, since a browser's APIs refuse a view of shared memory.
 *
 * A binding over libuv has no meaning in a realm with no such program: there it answers that, and nothing in its
 * place.
 */

/** What native/node exports to the bindings: each is named for the Node function it carries, in its C file. */
export interface LibnodeExports {
  /** memory.c: the allocator a binding's records are made and freed with. */
  tabnode_malloc(size: number): number;
  tabnode_free(at: number): void;
  /** handle_wrap.c: HandleWrap's calls on its uv_handle_t. */
  tabnode_handle_close(handle: number): void;
  tabnode_handle_ref(handle: number): void;
  tabnode_handle_unref(handle: number): void;
  tabnode_handle_has_ref(handle: number): number;
  /** process_wrap.c: ProcessWrap's. */
  tabnode_process_new(): number;
  tabnode_process_spawn(process: number, options: number): number;
  tabnode_process_pid(process: number): number;
  tabnode_process_kill(process: number, signal: number): number;
  /** spawn_sync.c: SyncProcessRunner's run, and its result's release. */
  tabnode_spawn_sync(options: number): number;
  tabnode_spawn_sync_free(result: number): void;
}

/** The program as its host gives it: its exports once instantiated, and the process's memory's one door. */
export interface Libnode {
  readonly exports: LibnodeExports;
  /** A copy of `length` bytes of the process's memory at `at`. */
  read(at: number, length: number): Uint8Array;
  /** `bytes` into the process's memory at `at`. */
  write(at: number, bytes: Uint8Array): void;
}

let attached: Libnode | null = null;

/** The host's program, attached once, before Node's library runs. */
export function attachLibnode(program: Libnode): void {
  attached = program;
}

/** The program a binding calls: refused where the realm has none, since a binding over libuv is its C. */
export function libnode(): Libnode {
  if (attached === null) throw new Error('this realm has no node program: its bindings over libuv are the program\'s C (ADR-0018 §3)');
  return attached;
}

/** A wasm32 address as the program answers it (an i32, negative from 2 GiB), as an offset. */
export function address(value: number): number {
  return value >>> 0;
}

/** A record of `length` bytes at `at`, read whole once: its fields at offsets from 0. */
export function readRecord(at: number, length: number): DataView {
  const bytes = libnode().read(address(at), length);
  return new DataView(bytes.buffer, bytes.byteOffset, length);
}

const utf8 = new TextEncoder();

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
    const encoded = utf8.encode(text);
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
    if (at === 0) throw new RangeError('node: out of memory for a call\'s record');
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
