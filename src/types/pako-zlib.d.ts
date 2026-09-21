/**
 * pako's zlib layer has no types of its own: it is zlib's C ported to
 * JavaScript, and DefinitelyTyped describes only pako's public API. The
 * shapes the engine relies on are stated where they are used, in
 * `src/node-lib/binding/zlib-pako.ts`; this says the modules exist.
 */
declare module 'pako/lib/zlib/zstream.js' {
  const ZStream: new () => Record<string, unknown>;
  export default ZStream;
}
declare module 'pako/lib/zlib/inflate.js' {
  const value: Record<string, unknown>;
  export = value;
}
declare module 'pako/lib/zlib/deflate.js' {
  const value: Record<string, unknown>;
  export = value;
}
declare module 'pako/lib/zlib/constants.js' {
  const value: Record<string, number>;
  export default value;
}
declare module 'pako/lib/zlib/crc32.js' {
  const value: (crc: number, buffer: Uint8Array, length: number, position: number) => number;
  export default value;
}
declare module 'pako/lib/zlib/messages.js' {
  const value: Record<number, string>;
  export default value;
}
