/**
 * Brotli decoding for `zlib`'s `BrotliDecoder`, on `brotli-wasm`'s module
 * (its bytes inlined: an engine realm's network is closed), instantiated the
 * first time a Brotli stream is made rather than as the engine loads. Every
 * process realm loads the engine and few decode Brotli; the pure-JavaScript
 * decoder this replaces decoded its own 120 KB dictionary as it was imported,
 * about 10 ms of every process's start (2026-09-26, measured natively).
 *
 * The module's own glue (`pkg.web/brotli_wasm.js`) instantiates only
 * asynchronously, and `zlib.brotliDecompressSync` must answer before a
 * promise can; this is the glue's decode half, instantiated either way:
 * compiled off the thread when a stream is made, synchronously when a
 * synchronous decode comes first.
 */
// @ts-expect-error `?base64` is the build's own (scripts/base64-asset-plugin.mjs): the file as base64.
import brotliWasmBase64 from '../../../node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm?base64';

interface BrotliExports {
  memory: WebAssembly.Memory;
  decompress(retptr: number, ptr: number, len: number): void;
  __wbindgen_malloc(size: number): number;
  __wbindgen_free(ptr: number, size: number): void;
  __wbindgen_add_to_stack_pointer(delta: number): number;
}

let exports: BrotliExports | null = null;
let compiling: Promise<void> | null = null;

function wasmBytes(): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (fromBase64) return fromBase64(String(brotliWasmBase64));
  const binary = atob(String(brotliWasmBase64));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The objects the module hands back by index (wasm-bindgen's heap): here,
 * only the error a failed decode throws. Indices below 36 are its reserved
 * slots, as the glue's.
 */
const heap: unknown[] = new Array(32).fill(undefined);
heap.push(undefined, null, true, false);
let heapNext = heap.length;
function addHeapObject(value: unknown): number {
  if (heapNext === heap.length) heap.push(heap.length + 1);
  const index = heapNext;
  heapNext = heap[index] as number;
  heap[index] = value;
  return index;
}
function takeObject(index: number): unknown {
  const value = heap[index];
  if (index >= 36) { heap[index] = heapNext; heapNext = index; }
  return value;
}
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const text = (ptr: number, len: number): string => textDecoder.decode(new Uint8Array(exports!.memory.buffer, ptr, len));

/**
 * What the module imports, by name with wasm-bindgen's hash dropped. The
 * decoder reaches only the error ones; the rest are the encoder's, answered
 * so the module links.
 */
function importsFor(module: WebAssembly.Module): WebAssembly.Imports {
  const answers: Record<string, (...args: number[]) => unknown> = {
    __wbindgen_is_undefined: (index) => heap[index] === undefined,
    __wbindgen_is_object: (index) => typeof heap[index] === 'object' && heap[index] !== null,
    __wbindgen_string_new: (ptr, len) => addHeapObject(text(ptr, len)),
    __wbindgen_error_new: (ptr, len) => addHeapObject(new Error(text(ptr, len))),
    __wbindgen_object_drop_ref: (index) => { takeObject(index); },
    __wbindgen_throw: (ptr, len) => { throw new Error(text(ptr, len)); },
    __wbg_new: () => addHeapObject(new Error()),
  };
  const wbg: Record<string, (...args: number[]) => unknown> = {};
  for (const { module: from, name } of WebAssembly.Module.imports(module)) {
    if (from !== 'wbg') continue;
    wbg[name] = answers[name] ?? answers[name.replace(/_[0-9a-f]{16}$/, '')] ?? (() => {
      throw new Error(`brotli-wasm's ${name} is the encoder's, and the engine has no Brotli encoder`);
    });
  }
  return { wbg };
}

function link(module: WebAssembly.Module): void {
  exports ??= new WebAssembly.Instance(module, importsFor(module)).exports as unknown as BrotliExports;
}

/** Begins compiling the module off the thread, once; a stream's decode waits for it. */
export function brotliDecoderReady(): Promise<void> {
  if (exports) return Promise.resolve();
  compiling ??= WebAssembly.compile(wasmBytes()).then(link);
  return compiling;
}

/** The whole of `input`, decoded; compiles the module synchronously when nothing has yet. */
export function brotliDecompress(input: Uint8Array): Uint8Array {
  if (!exports) link(new WebAssembly.Module(wasmBytes()));
  const wasm = exports!;
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const ptr = wasm.__wbindgen_malloc(input.length);
    new Uint8Array(wasm.memory.buffer).set(input, ptr);
    wasm.decompress(retptr, ptr, input.length);
    const [outPtr, outLen, error, failed] = new Int32Array(wasm.memory.buffer, retptr, 4);
    if (failed) throw takeObject(error!);
    const output = new Uint8Array(wasm.memory.buffer, outPtr, outLen).slice();
    wasm.__wbindgen_free(outPtr!, outLen!);
    return output;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
