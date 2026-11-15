declare global {
  interface Uint8ArrayConstructor {
    /** ECMAScript 2026's base64 decode (Chrome 140, Firefox 133, Safari 18.2, Node 25). */
    fromBase64(text: string, options?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' }): Uint8Array<ArrayBuffer>;
  }
}

/**
 * A WebAssembly module's bytes from the base64 text the engine carries them in, decoded by the engine's own decoder:
 * a JavaScript decode (`atob`, then a byte a character) of node-deps.wasm's 4 MB took 130 ms of a process's first
 * crypto use, `Uint8Array.fromBase64` 0.5 ms (read 2026-11-14 on Node 26).
 */
export function moduleBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.fromBase64(base64);
}
