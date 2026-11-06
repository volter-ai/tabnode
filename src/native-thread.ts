/**
 * A thread's side of an addon's imports (ADR-0011 §3, §4), made in the thread's own worker, which the substrate's
 * dynamic linker starts for the addon's process and in which it instantiates the addon again (`TREE_NATIVE`,
 * `host-native.ts`). The worker imports this module alone, with none of the engine.
 *
 * The imports are emnapi's child-thread module's (`createNapiModule({ childThread: true })`), whose one message to
 * the main thread, `uv_async_send`'s, goes to the load's queue (`native-queue.ts`). Node-API allows a thread no other
 * call into JavaScript, so every `napi` and `emnapi` import here aborts, as `napi_fatal_error` does.
 */
import { createNapiModule } from '@emnapi/core';
import { sendNative } from './native-queue';

type AsyncSend = { __emnapi__?: { type?: string; payload?: { callback?: number; data?: number } } };

const forbidden = (module: string, name: string) => (): never => {
  throw new WebAssembly.RuntimeError(`FATAL ERROR: ${module}.${name} called off the addon's main thread`);
};

/** The imports a thread's instance of the addon takes beside its `wali` imports and the linker's own. */
export function threadImports(queue: SharedArrayBuffer): WebAssembly.Imports {
  const napiModule = createNapiModule({
    childThread: true,
    postMessage: (message: AsyncSend): void => {
      const send = message?.__emnapi__;
      if (send?.type !== 'async-send') return;
      sendNative(queue, 0, send.payload?.callback ?? 0, send.payload?.data ?? 0);
    },
  });
  const abortAll = (module: 'napi' | 'emnapi'): WebAssembly.ModuleImports =>
    Object.fromEntries(Object.keys(napiModule.imports[module] ?? {}).map((name) => [name, forbidden(module, name)]));
  return { env: napiModule.imports.env, napi: abortAll('napi'), emnapi: abortAll('emnapi') };
}
