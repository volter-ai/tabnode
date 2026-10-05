/** The browser has structured clone, but no V8's binary wire codec.
 * Default JSON IPC does not call these methods. Advanced IPC fails at use,
 * rather than misencoding Buffers, cycles, BigInts or other V8 values as JSON. */
function unsupported(): never {
  throw Object.assign(new Error("Advanced IPC serialization requires the native V8 binary codec, unavailable in this engine."),
    { code: 'ERR_UNSUPPORTED_OPERATION', capability: 'ipc.v8-serialization' });
}
export default { serialize: unsupported, deserialize: unsupported };
