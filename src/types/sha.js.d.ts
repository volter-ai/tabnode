/**
 * sha.js ships no types. It is a CommonJS factory: SHA(algorithm) returns a
 * streaming hash whose state lives in own fields, which crypto.ts copies by
 * value for Hash.copy() because sha.js has no clone.
 */
declare module 'sha.js' {
  interface ShaHash {
    update(data: Uint8Array | string, encoding?: string): ShaHash;
    digest(): Uint8Array;
    [field: string]: unknown;
  }
  function SHA(algorithm: string): ShaHash;
  export = SHA;
}
