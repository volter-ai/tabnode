/**
 * llhttp, compiled to WebAssembly.
 *
 * VENDORED ARTIFACT, UNMODIFIED. This is the build undici ships -- llhttp is
 * the parser Node itself links, and undici is the one project that already
 * compiles it for a runtime with no C in it, which is what a tab is.
 *
 *   source:  undici 6.28.0, lib/llhttp/llhttp-wasm.js
 *   bytes:   48615
 *   sha256:  b96063c7ce14045f91f17489d8b30a2bf5129308bd801d7dde715579d16d0e21
 *   license: MIT (llhttp, nodejs/llhttp; undici, nodejs/undici)
 *
 * The base64 below is that file's own payload, byte for byte; nothing here is
 * edited. `./http_parser.ts` instantiates it and gives Node's own
 * `_http_common.js` the `HTTPParser` it expects on top.
 *
 * The non-SIMD build is the one taken: a tab's WebAssembly does not promise
 * SIMD, and llhttp's SIMD path buys throughput this engine is nowhere near
 * needing.
 */
export declare const LLHTTP_WASM_BASE64: string;
//# sourceMappingURL=llhttp-wasm.d.ts.map