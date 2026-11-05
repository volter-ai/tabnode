/**
 * `internalBinding('wasm_web_api')`, as Node's `src/node_wasm_web_api.cc` is: the process's bootstrap gives it the
 * streaming callback (`setImplementation`, Node's `internal/wasm_web_api.js` `wasmStreamingCallback`), and a
 * `WebAssembly.compileStreaming(source)` hands that callback a `WasmStreamingObject` (`setURL`, `push`, `finish`,
 * `abort`) to feed V8's streaming compiler with the Response's bytes. The realm's V8 streams them the same way: its
 * own `compileStreaming` over a stream of exactly the bytes pushed, so compilation runs as they arrive. One binding per
 * process, so a process's Response is its own undici's.
 */
type StreamingCallback = (streamState: WasmStreamingObject, source: unknown) => void;

interface WasmStreamingObject {
  setURL(url: string): void;
  push(chunk: ArrayBufferView | ArrayBuffer): void;
  finish(): void;
  abort(error: unknown): void;
}

export function createWasmWebApiBinding(): {
  setImplementation(callback: StreamingCallback): void;
  compileStreaming(source: unknown): Promise<WebAssembly.Module>;
} {
  let implementation: StreamingCallback | undefined;
  return {
    setImplementation(callback) { implementation = callback; },
    compileStreaming(source) {
      return new Promise<WebAssembly.Module>((resolve, reject) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let aborted: { error: unknown } | undefined;
        const body = new ReadableStream<Uint8Array>({ start(given) { controller = given; } });
        WebAssembly.compileStreaming(new Response(body, { headers: { 'content-type': 'application/wasm' } }))
          .then(resolve, (error: unknown) => reject(aborted ? aborted.error : error));
        const state: WasmStreamingObject = {
          setURL() {},
          push(chunk) {
            const view = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
            controller.enqueue(view.slice());
          },
          finish() { controller.close(); },
          abort(error) { aborted = { error }; controller.error(error); },
        };
        implementation!(state, source);
      });
    },
  };
}
