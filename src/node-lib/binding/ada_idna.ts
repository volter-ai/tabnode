/**
 * Ada's own `ada::idna::to_ascii`, the conversion Node's `cares_wrap` makes of every name before `getaddrinfo` and
 * before a c-ares query (ADR-0009 §3): Ada's C++ compiled to WebAssembly (`./ada-idna-wasm.ts`), instantiated
 * synchronously the first time a name is converted. A name Ada cannot convert answers the empty string, as Ada does.
 */
import { ADA_IDNA_WASM_BASE64 } from './ada-idna-wasm';

interface AdaIdna {
  memory: WebAssembly.Memory;
  tabnode_idna_input(length: number): number;
  tabnode_idna_to_ascii(length: number): number;
  tabnode_idna_result(): number;
}

let ada: AdaIdna | undefined;
function adaIdna(): AdaIdna {
  if (ada) return ada;
  const bytes = Uint8Array.from(atob(ADA_IDNA_WASM_BASE64), (character) => character.charCodeAt(0));
  // Its one import is WASI's fd_write, which an assertion's message would take; nothing is written: ENOSYS.
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { wasi_snapshot_preview1: { fd_write: () => 52 } });
  (instance.exports._initialize as () => void)();
  return ada = instance.exports as unknown as AdaIdna;
}

/** `ada::idna::to_ascii` of `name`, as UTF-8 (a lone surrogate is U+FFFD, as Node's `Utf8Value` makes it). */
export function adaToAscii(name: string): string {
  const module = adaIdna();
  const utf8 = new TextEncoder().encode(name);
  const at = module.tabnode_idna_input(utf8.byteLength) >>> 0;
  new Uint8Array(module.memory.buffer, at, utf8.byteLength).set(utf8);
  const length = module.tabnode_idna_to_ascii(utf8.byteLength) >>> 0;
  const result = module.tabnode_idna_result() >>> 0;
  return new TextDecoder().decode(new Uint8Array(module.memory.buffer, result, length));
}
