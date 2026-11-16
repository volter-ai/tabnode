/**
 * `internalBinding('zlib')` (ADR-0018 §1, item 10): Node v24.21.0's src/node_zlib.cc over the zlib (Chromium's, as
 * Node's deps/zlib ships it), brotli and zstd in the process's `node` program, and so is its C
 * (native/node/node_zlib.c): every context (ZlibContext, BrotliEncoderContext, BrotliDecoderContext,
 * ZstdCompressContext, ZstdDecompressContext) and CompressionStream's state, its checks, its errors and its writes,
 * a `write` on libuv's threadpool (uv_queue_work) completing on the loop through the program's `zlib_done`, after
 * which the C closes the callback's scope. This file is its V8 half: each method reads its arguments as Node's
 * FunctionCallbackInfo reads them and throws what Node's C++ throws from V8, a write's buffers are copied into the
 * stream's room in the process's memory and its output copied back (a browser's APIs refuse a view of shared
 * memory), the write result is copied into the stream's Uint32Array, and `onerror` and the write callback are made as
 * MakeCallback makes them, in the stream's owner's run. Node's own `lib/zlib.js` runs over it unchanged.
 *
 * A realm the host gives no `node` program has no zlib, as it has no OpenSSL: its streams and `crc32` answer that
 * the realm has no program (`nodeProgram`).
 */
import { address, fromMemory, intoMemory, nodeProgram, readRecord, setZlibCallbacks, type NodeProgramExports } from './program';
import { codeError } from './fs_req';
import { invokeOwned, ownedRun, ownerOfInstance } from './handles';

type I32 = number;

/** native/node/node_zlib.c's exports, by their C names. */
interface ZlibExports extends NodeProgramExports {
  tabnode_zlib_new(kind: I32, mode: I32): I32;
  tabnode_zlib_free(stream: I32): void;
  tabnode_zlib_init_stream(stream: I32): void;
  tabnode_zlib_init_arity(argc: I32): void;
  tabnode_zlib_init(stream: I32, level: I32, windowBits: I32, memLevel: I32, strategy: I32, rejectGarbageAfterEnd: I32,
    dictionary: I32, size: I32): void;
  tabnode_zlib_params(stream: I32, level: I32, strategy: I32): I32;
  tabnode_brotli_init(stream: I32, dictionary: I32, size: I32): I32;
  tabnode_brotli_set_param(stream: I32, key: I32, value: I32): I32;
  tabnode_zstd_init(stream: I32, hasPledge: I32, pledge: bigint, dictionary: I32, size: I32): I32;
  tabnode_zstd_set_param(stream: I32, key: I32, value: I32): I32;
  tabnode_zlib_reset(stream: I32): I32;
  tabnode_zlib_close(stream: I32): void;
  tabnode_zlib_room(stream: I32, size: I32): I32;
  tabnode_zlib_write(stream: I32, flush: I32, hasIn: I32, inLen: I32, outLen: I32, async: I32): I32;
  tabnode_zlib_write_result(stream: I32): I32;
  tabnode_zlib_produced(stream: I32, outLen: I32): I32;
  tabnode_zlib_error_message(stream: I32): I32;
  tabnode_zlib_crc32(data: I32, size: I32, value: I32): I32;
  tabnode_zlib_version(): I32;
}

function program(): ZlibExports {
  return nodeProgram().exports as ZlibExports;
}

/** The stream kinds node_zlib.c makes, one a class of Node's MakeClass. */
const kZlib = 0, kBrotliEncoder = 1, kBrotliDecoder = 2, kZstdCompress = 3, kZstdDecompress = 4;

/** Node's CHECK (src/util.h), which aborts the process; a V8 half's argument CHECK is raised here as an error. */
function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`node: Assertion \`${what}' failed`);
}

/** V8's Uint32Value and Int32Value: ToNumber (which throws for a BigInt or a Symbol), then the 32-bit wrap. */
function uint32Value(value: unknown): number { return (+(value as number)) >>> 0; }
function int32Value(value: unknown): number { return (+(value as number)) | 0; }

/** `value->IsInt32()`. */
function isInt32(value: unknown): value is number {
  return typeof value === 'number' && (value | 0) === value && !Object.is(value, -0);
}

/** The bytes an ArrayBufferView names (Buffer::Data, ArrayBufferViewContents). */
function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Buffer::IsWithinBounds (src/node_buffer.h): `off + len` within `max`, with no overflow. */
function isWithinBounds(off: number, len: number, max: number): boolean {
  return off <= max && len <= max - off;
}

/** Every stream by its address, for the C's callbacks (Node's wrap from its object), until its object is collected. */
const streams = new Map<number, WeakRef<CompressionStream>>();
/**
 * A stream with a threadpool write in flight, held as Node's Ref holds it (ClearWeak) until its write is done
 * (`zlib_done`); then it is weak again.
 */
const writing = new Map<number, CompressionStream>();
/** ~CompressionStream once the object is collected (MakeWeak), as V8's weak callback deletes it. */
const collected = new FinalizationRegistry<number>((at) => {
  streams.delete(at);
  program().tabnode_zlib_free(at);
});

/** A write's buffers, from its call to its end: the JavaScript output, its offset and length, and the room. */
interface PendingWrite { out: Uint8Array; outOff: number; outLen: number; inLen: number; room: number }

/**
 * CompressionStream (node_zlib.cc:442-734): an AsyncWrap over its C stream, whose write result and write callback
 * (kWriteJSCallback) are V8's and so kept here.
 */
class CompressionStream {
  readonly #stream: number;
  #writeResult: Uint32Array | null = null;
  #writeCallback: (() => unknown) | null = null;
  #pending: PendingWrite | null = null;
  /** `zlib.js` sets it; EmitError's MakeCallback calls it. */
  declare onerror: ((message: string, errno: number, code: string) => void) | undefined;

  constructor(kind: number, mode: number) {
    this.#stream = address(program().tabnode_zlib_new(kind, mode));
    streams.set(this.#stream, new WeakRef(this));
    collected.register(this, this.#stream);
  }

  /** The stream's address in the process's memory. */
  protected get stream(): number { return this.#stream; }

  /** InitStream (node_zlib.cc:691-695). */
  protected initStream(writeResult: Uint32Array, writeCallback: () => unknown): void {
    this.#writeResult = writeResult;
    this.#writeCallback = writeCallback;
    program().tabnode_zlib_init_stream(this.#stream);
  }

  /** CompressionStream::Close (node_zlib.cc:484-488). */
  close(): void { program().tabnode_zlib_close(this.#stream); }

  /** Write<true> (node_zlib.cc:492-544): write(flush, in, in_off, in_len, out, out_off, out_len). */
  write(...args: unknown[]): void { this.#write(true, args); }
  /** Write<false>. */
  writeSync(...args: unknown[]): void { this.#write(false, args); }

  /** Reset (node_zlib.cc:653-667). */
  reset(): void {
    if (program().tabnode_zlib_reset(this.#stream) < 0) throw new Error('Cannot reset zlib stream while a write is in progress');
  }

  /** Params: a no-op but Zlib's (node_zlib.cc:919-924, 1022-1027). */
  params(..._args: unknown[]): void {}

  #write(async: boolean, args: unknown[]): void {
    check(args.length === 7, 'args.Length() == 7');
    check(args[0] !== undefined, 'must provide flush value');
    const flush = uint32Value(args[0]);
    let input: Uint8Array | null = null;
    let inOff = 0, inLen = 0;
    if (args[1] !== null) {
      check(ArrayBuffer.isView(args[1]), 'Buffer::HasInstance(args[1])');
      inOff = uint32Value(args[2]);
      inLen = uint32Value(args[3]);
      input = viewBytes(args[1]);
      if (!isWithinBounds(inOff, inLen, input.byteLength)) {
        throw codeError('ERR_OUT_OF_RANGE', 'input buffer is out of bounds', RangeError);
      }
    }
    check(ArrayBuffer.isView(args[4]), 'Buffer::HasInstance(args[4])');
    const out = viewBytes(args[4]);
    const outOff = uint32Value(args[5]);
    const outLen = uint32Value(args[6]);
    if (!isWithinBounds(outOff, outLen, out.byteLength)) {
      throw codeError('ERR_OUT_OF_RANGE', 'output buffer is out of bounds', RangeError);
    }
    const x = program();
    const room = address(x.tabnode_zlib_room(this.#stream, inLen + outLen));
    if (input && inLen > 0) nodeProgram().write(room, input.subarray(inOff, inOff + inLen));
    const pending = { out, outOff, outLen, inLen, room };
    if (async) {
      // ScheduleWork, with the stream held (Ref) until its work is done.
      this.#pending = pending;
      writing.set(this.#stream, this);
      x.tabnode_zlib_write(this.#stream, flush, input ? 1 : 0, inLen, outLen, 1);
      return;
    }
    const failed = x.tabnode_zlib_write(this.#stream, flush, input ? 1 : 0, inLen, outLen, 0) !== 0;
    this.#takeOutput(pending);
    if (!failed) this.#updateWriteResult();
  }

  /** The bytes the write produced, out of the room into the JavaScript buffer, as zlib wrote them there in Node. */
  #takeOutput(pending: PendingWrite): void {
    const produced = program().tabnode_zlib_produced(this.#stream, pending.outLen) >>> 0;
    if (produced > 0) pending.out.set(new Uint8Array(fromMemory(pending.room + pending.inLen, produced)), pending.outOff);
  }

  /** UpdateWriteResult (node_zlib.cc:579-581): the C's write_result into the stream's Uint32Array. */
  #updateWriteResult(): void {
    const result = readRecord(program().tabnode_zlib_write_result(this.#stream), 8);
    const target = this.#writeResult;
    if (!target) return;
    target[0] = result.getUint32(0, true);
    target[1] = result.getUint32(4, true);
  }

  /** EmitError's MakeCallback (node_zlib.cc:634-651): `onerror(message, errno, code)`. */
  emitError(message: string, errno: number, code: string): void {
    invokeOwned(this, 'onerror', message, errno, code);
  }

  /** AfterThreadPoolWork's V8 part (node_zlib.cc:601-631): the output, then UpdateWriteResult and the write callback. */
  writeDone(written: boolean): void {
    writing.delete(this.#stream);
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#takeOutput(pending);
    if (!written) return;
    this.#updateWriteResult();
    const callback = this.#writeCallback;
    if (typeof callback !== 'function') return;
    ownedRun(ownerOfInstance(this), () => callback.call(this), true, 'zlib', callback);
  }
}

/** The stream at an address the C names. */
function streamAt(at: number): CompressionStream {
  const stream = streams.get(address(at))?.deref();
  if (!stream) throw new Error(`node: zlib called back a stream no binding holds (${address(at)})`);
  return stream;
}

/** A dictionary's bytes copied into the process's memory, its address and length (0 and 0 for none). */
function dictionaryInMemory(view: ArrayBufferView | undefined): { at: number; size: number } {
  if (view === undefined || view.byteLength === 0) return { at: 0, size: 0 };
  return { at: intoMemory(viewBytes(view).slice()), size: view.byteLength };
}

/** ZlibStream (node_zlib.cc:736-840). */
class Zlib extends CompressionStream {
  constructor(mode: unknown) {
    check(isInt32(mode), 'args[0]->IsInt32()');
    super(kZlib, mode);
  }

  /**
   * Init (node_zlib.cc:751-820): init(windowBits, level, memLevel, strategy, writeResult, writeCallback, dictionary[,
   * rejectGarbageAfterEnd]).
   */
  init(...args: unknown[]): void {
    const x = program();
    x.tabnode_zlib_init_arity(args.length);
    const windowBits = uint32Value(args[0]);
    const level = int32Value(args[1]);
    const memLevel = uint32Value(args[2]);
    const strategy = uint32Value(args[3]);
    check(args[4] instanceof Uint32Array, 'args[4]->IsUint32Array()');
    check(args[4].length >= 2, 'array->Length() >= 2');
    check(typeof args[5] === 'function', 'args[5]->IsFunction()');
    const dictionary = ArrayBuffer.isView(args[6]) ? args[6] : undefined;
    let rejectGarbageAfterEnd = false;
    if (args.length === 8) {
      check(typeof args[7] === 'boolean', 'args[7]->IsBoolean()');
      rejectGarbageAfterEnd = args[7] === true;
    }
    this.initStream(args[4], args[5] as () => unknown);
    // The dictionary's copy is the context's (its std::vector), freed by the C.
    const { at, size } = dictionaryInMemory(dictionary);
    x.tabnode_zlib_init(this.stream, level, windowBits, memLevel, strategy, rejectGarbageAfterEnd ? 1 : 0, at, size);
  }

  /** Params (node_zlib.cc:822-836). */
  override params(...args: unknown[]): void {
    check(args.length === 2, 'params(level, strategy)');
    const level = int32Value(args[0]);
    const strategy = int32Value(args[1]);
    program().tabnode_zlib_params(this.stream, level, strategy);
  }
}

/** The optional dictionary of a Brotli or Zstd init: an ArrayBufferView, or THROW_ERR_INVALID_ARG_TYPE. */
function optionalDictionary(args: unknown[], index: number): ArrayBufferView | undefined {
  if (args.length !== index + 1 || args[index] === undefined) return undefined;
  if (!ArrayBuffer.isView(args[index])) {
    throw codeError('ERR_INVALID_ARG_TYPE', 'dictionary must be an ArrayBufferView if provided', TypeError);
  }
  return args[index] as ArrayBufferView;
}

/** BrotliCompressionStream (node_zlib.cc:842-931). */
class BrotliStream extends CompressionStream {
  constructor(kind: number, mode: unknown) {
    check(isInt32(mode), 'args[0]->IsInt32()');
    super(kind, mode);
  }

  /** Init (node_zlib.cc:865-917): init(params, writeResult, writeCallback[, dictionary]). */
  init(...args: unknown[]): void {
    check(args.length === 3 || args.length === 4, 'init(params, writeResult, writeCallback[, dictionary])');
    check(args[1] instanceof Uint32Array && args[1].length >= 2, 'args[1]->IsUint32Array()');
    check(typeof args[2] === 'function', 'args[2]->IsFunction()');
    this.initStream(args[1], args[2] as () => unknown);
    const dictionary = optionalDictionary(args, 3);
    const x = program();
    // The dictionary's copy is the context's, freed by the C.
    const { at, size } = dictionaryInMemory(dictionary);
    if (x.tabnode_brotli_init(this.stream, at, size) !== 0) {
      throw codeError('ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
    }
    check(args[0] instanceof Uint32Array, 'args[0]->IsUint32Array()');
    const params = args[0];
    for (let index = 0; index < params.length; index++) {
      if (params[index] === 0xffffffff) continue;
      if (x.tabnode_brotli_set_param(this.stream, index, params[index]!) !== 0) {
        throw codeError('ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
      }
    }
  }
}

class BrotliEncoder extends BrotliStream {
  constructor(mode: unknown) { super(kBrotliEncoder, mode); }
}

class BrotliDecoder extends BrotliStream {
  constructor(mode: unknown) { super(kBrotliDecoder, mode); }
}

/** ZstdStream (node_zlib.cc:933-1034). */
class ZstdStream extends CompressionStream {
  constructor(kind: number) { super(kind, 0); }

  /** Init (node_zlib.cc:949-1020): init(params, pledgedSrcSize, writeResult, writeCallback[, dictionary]). */
  init(...args: unknown[]): void {
    check(args.length === 4 || args.length === 5,
      'init(params, pledgedSrcSize, writeResult, writeCallback[, dictionary])');
    check(args[2] instanceof Uint32Array && args[2].length >= 2, 'args[2]->IsUint32Array()');
    check(typeof args[3] === 'function', 'args[3]->IsFunction()');
    this.initStream(args[2], args[3] as () => unknown);
    let hasPledge = 0;
    let pledge = 0n;
    if (args[1] !== undefined) {
      if (typeof args[1] !== 'number') {
        throw codeError('ERR_INVALID_ARG_TYPE', 'pledgedSrcSize must be a number', TypeError);
      }
      if (!Number.isSafeInteger(args[1])) {
        throw codeError('ERR_OUT_OF_RANGE', 'pledgedSrcSize must be a safe integer', RangeError);
      }
      if (args[1] < 0) throw codeError('ERR_OUT_OF_RANGE', 'pledgedSrcSize must be non-negative', RangeError);
      hasPledge = 1;
      pledge = BigInt(args[1]);
    }
    const dictionary = optionalDictionary(args, 4);
    const x = program();
    const { at, size } = dictionaryInMemory(dictionary);
    let failed: boolean;
    // ZSTD_CCtx_loadDictionary and ZSTD_DCtx_loadDictionary copy it; the call's copy is freed after.
    try { failed = x.tabnode_zstd_init(this.stream, hasPledge, pledge, at, size) !== 0; }
    finally { if (at) x.tabnode_free(at); }
    if (failed) throw codeError('ERR_ZLIB_INITIALIZATION_FAILED', this.#errorMessage());
    check(args[0] instanceof Uint32Array, 'args[0]->IsUint32Array()');
    const params = args[0];
    for (let index = 0; index < params.length; index++) {
      if (params[index] === 0xffffffff) continue;
      if (x.tabnode_zstd_set_param(this.stream, index, params[index]! | 0) !== 0) {
        throw codeError('ERR_ZLIB_INITIALIZATION_FAILED', this.#errorMessage());
      }
    }
  }

  #errorMessage(): string {
    return nodeProgram().cString(program().tabnode_zlib_error_message(this.stream)) ?? '';
  }
}

class ZstdCompress extends ZstdStream {
  constructor() { super(kZstdCompress); }
}

class ZstdDecompress extends ZstdStream {
  constructor() { super(kZstdDecompress); }
}

/** CRC32 (node_zlib.cc:1862-1877): zlib's crc32 of an ArrayBufferView's bytes or a string's UTF-8 (Utf8Value). */
function crc32(data: unknown, value: unknown): number {
  check(ArrayBuffer.isView(data) || typeof data === 'string', 'args[0]->IsArrayBufferView() || args[0]->IsString()');
  check(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'args[1]->IsUint32()');
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : viewBytes(data as ArrayBufferView);
  const x = program();
  const at = intoMemory(bytes);
  try { return x.tabnode_zlib_crc32(at, bytes.byteLength, value) >>> 0; }
  finally { x.tabnode_free(at); }
}

/**
 * The program's zlib callbacks (engine.h `zlib_error`, `zlib_done`), which `nodeProgramImports` answers: EmitError's
 * MakeCallback of `onerror`, and a threadpool write's end. The C closes the scope of each made on the loop.
 */
setZlibCallbacks({
  zlib_error: (stream, message, code, err) => {
    streamAt(stream).emitError(nodeProgram().cString(message) ?? '', err, nodeProgram().cString(code) ?? '');
  },
  zlib_done: (stream, written) => { streamAt(stream).writeDone(written !== 0); },
});

/** Initialize (node_zlib.cc:1892-1908): the five classes, `crc32` and ZLIB_VERSION, the program's. */
export const zlibBinding = {
  Zlib,
  BrotliEncoder,
  BrotliDecoder,
  ZstdCompress,
  ZstdDecompress,
  crc32,
  get ZLIB_VERSION(): string { return nodeProgram().cString(program().tabnode_zlib_version()) ?? ''; },
};

export default zlibBinding;
