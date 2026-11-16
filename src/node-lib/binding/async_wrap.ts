/**
 * `internalBinding('async_wrap')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's src/async_wrap.cc
 * and the Environment's AsyncHooks (src/env.cc:124-214, 1781-1807), for Node's own `lib/internal/async_hooks.js`,
 * which keeps its state in these arrays as Node's C++ and JavaScript share them.
 *
 * Where this differs from Node:
 * - `setPromiseHooks` keeps the four hooks and `getPromiseHooks` answers them, but a page's engine has no V8
 *   PromiseHook, so no promise calls them: an `async_hooks.createHook` sees no PROMISE resource.
 * - `registerDestroyHook`'s weak callback is a FinalizationRegistry's, which the engine's collector calls when it
 *   collects, as V8's weak callback is; the destroy hooks it queues run from an unreferenced immediate of the loop's
 *   check phase, where Node's run from its native immediate queue before the JavaScript ones.
 */
import { setImmediate as engineSetImmediate, type EngineTimer } from '../../engine-timers';

/** AsyncHooks::Fields (src/env.h:292-303). */
const kInit = 0, kBefore = 1, kAfter = 2, kDestroy = 3, kPromiseResolve = 4, kTotals = 5, kCheck = 6, kStackLength = 7,
  kUsesExecutionAsyncResource = 8, kFieldsCount = 9;
/** AsyncHooks::UidFields (src/env.h:305-311). */
const kExecutionAsyncId = 0, kTriggerAsyncId = 1, kAsyncIdCounter = 2, kDefaultTriggerAsyncId = 3, kUidFieldsCount = 4;

/** NODE_ASYNC_PROVIDER_TYPES (src/async_wrap.h:34-105), the crypto providers with them: the program has OpenSSL. */
const PROVIDERS = ['NONE', 'DIRHANDLE', 'DNSCHANNEL', 'ELDHISTOGRAM', 'FILEHANDLE', 'FILEHANDLECLOSEREQ', 'BLOBREADER',
  'FSEVENTWRAP', 'FSREQCALLBACK', 'FSREQPROMISE', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'HEAPSNAPSHOT',
  'HTTP2SESSION', 'HTTP2STREAM', 'HTTP2PING', 'HTTP2SETTINGS', 'HTTPINCOMINGMESSAGE', 'HTTPCLIENTREQUEST', 'LOCKS',
  'JSSTREAM', 'JSUDPWRAP', 'MESSAGEPORT', 'PIPECONNECTWRAP', 'PIPESERVERWRAP', 'PIPEWRAP', 'PROCESSWRAP', 'PROMISE',
  'QUERYWRAP', 'QUIC_ENDPOINT', 'QUIC_LOGSTREAM', 'QUIC_SESSION', 'QUIC_STREAM', 'QUIC_UDP', 'SHUTDOWNWRAP', 'SIGNALWRAP',
  'STATWATCHER', 'STREAMPIPE', 'TCPCONNECTWRAP', 'TCPSERVERWRAP', 'TCPWRAP', 'TTYWRAP', 'UDPSENDWRAP', 'UDPWRAP',
  'SIGINTWATCHDOG', 'WORKER', 'WORKERCPUPROFILE', 'WORKERCPUUSAGE', 'WORKERHEAPPROFILE', 'WORKERHEAPSNAPSHOT',
  'WORKERHEAPSTATISTICS', 'WRITEWRAP', 'ZLIB', 'CHECKPRIMEREQUEST', 'PBKDF2REQUEST', 'KEYPAIRGENREQUEST', 'KEYGENREQUEST',
  'KEYEXPORTREQUEST', 'ARGON2REQUEST', 'CIPHERREQUEST', 'DERIVEBITSREQUEST', 'HASHREQUEST', 'RANDOMBYTESREQUEST',
  'RANDOMPRIMEREQUEST', 'SCRYPTREQUEST', 'SIGNREQUEST', 'TLSWRAP', 'VERIFYREQUEST'];

const readOnly = (target: object, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { value, writable: false, enumerable: true, configurable: false });
};

interface HookFunctions { init: Function; before: Function; after: Function; destroy: Function; promise_resolve: Function }

export function createAsyncWrapBinding(): Record<string, unknown> {
  // AsyncHooks's constructor: clear_async_id_stack, kCheck 1 (--force-async-hooks-checks), no default trigger, the
  // counter at 1 for the bootstrap's own context.
  const fields = new Uint32Array(kFieldsCount);
  const asyncIdFields = new Float64Array(kUidFieldsCount);
  let asyncIdsStack = new Float64Array(16 * 2);
  const executionAsyncResources: object[] = [];
  const nativeResources: Array<object | undefined> = [];
  fields[kCheck] = 1;
  asyncIdFields[kDefaultTriggerAsyncId] = -1;
  asyncIdFields[kAsyncIdCounter] = 1;
  let hooks: HookFunctions | undefined;
  let promiseHooks: [unknown, unknown, unknown, unknown] = [undefined, undefined, undefined, undefined];
  const binding: Record<string, unknown> = {};

  const pushAsyncContext = (asyncId: number, triggerAsyncId: number, resource?: object): void => {
    if (fields[kCheck]! > 0 && (asyncId < -1 || triggerAsyncId < -1)) throw new RangeError('async_wrap: an async id below -1');
    const offset = fields[kStackLength]!;
    if (offset * 2 >= asyncIdsStack.length) {
      // grow_async_ids_stack (env.cc): three times the room, the binding's `async_ids_stack` the new array.
      const grown = new Float64Array(asyncIdsStack.length * 3);
      grown.set(asyncIdsStack);
      asyncIdsStack = grown;
      binding.async_ids_stack = grown;
    }
    asyncIdsStack[2 * offset] = asyncIdFields[kExecutionAsyncId]!;
    asyncIdsStack[2 * offset + 1] = asyncIdFields[kTriggerAsyncId]!;
    fields[kStackLength] = offset + 1;
    asyncIdFields[kExecutionAsyncId] = asyncId;
    asyncIdFields[kTriggerAsyncId] = triggerAsyncId;
    if (resource !== undefined) { nativeResources.length = offset + 1; nativeResources[offset] = resource; }
  };
  const popAsyncContext = (asyncId: number): boolean => {
    if (fields[kStackLength] === 0) return false;
    if (fields[kCheck]! > 0 && asyncIdFields[kExecutionAsyncId] !== asyncId) {
      // FailWithCorruptedAsyncStack: Node prints the stack and aborts.
      throw new Error(`async hook stack has become corrupted (actual: ${asyncIdFields[kExecutionAsyncId]}, expected: ${asyncId})`);
    }
    const offset = fields[kStackLength]! - 1;
    asyncIdFields[kExecutionAsyncId] = asyncIdsStack[2 * offset]!;
    asyncIdFields[kTriggerAsyncId] = asyncIdsStack[2 * offset + 1]!;
    fields[kStackLength] = offset;
    if (offset < nativeResources.length) nativeResources.length = offset;
    if (executionAsyncResources.length > offset) executionAsyncResources.length = offset;
    return fields[kStackLength]! > 0;
  };

  // AsyncWrap::EmitDestroy and DestroyAsyncIdsCallback (src/async_wrap.cc): ids queued while destroy hooks
  // are on, run together from one unreferenced immediate.
  let destroyIds: number[] = [];
  let destroyTurn: EngineTimer | undefined;
  const emitDestroy = (asyncId: number): void => {
    if (fields[kDestroy] === 0) return;
    if (destroyIds.length === 0) {
      destroyTurn = engineSetImmediate(() => {
        destroyTurn = undefined;
        while (destroyIds.length > 0) {
          const ids = destroyIds;
          destroyIds = [];
          for (const id of ids) hooks?.destroy(id);
        }
      });
      destroyTurn.unref();
    }
    destroyIds.push(asyncId);
  };
  const destroyRegistry = new FinalizationRegistry<{ asyncId: number; propBag?: { destroyed?: unknown } }>((param) => {
    if (param.propBag === undefined || param.propBag.destroyed === false || param.propBag.destroyed === undefined) emitDestroy(param.asyncId);
  });

  readOnly(binding, 'async_hook_fields', fields);
  readOnly(binding, 'async_id_fields', asyncIdFields);
  readOnly(binding, 'execution_async_resources', executionAsyncResources);
  binding.async_ids_stack = asyncIdsStack;
  const constants = {};
  for (const [name, value] of Object.entries({ kInit, kBefore, kAfter, kDestroy, kPromiseResolve, kTotals, kCheck,
    kExecutionAsyncId, kTriggerAsyncId, kAsyncIdCounter, kDefaultTriggerAsyncId, kUsesExecutionAsyncResource, kStackLength })) {
    readOnly(constants, name, value);
  }
  readOnly(binding, 'constants', constants);
  const providers = {};
  PROVIDERS.forEach((name, index) => readOnly(providers, name, index));
  readOnly(binding, 'Providers', providers);
  Object.assign(binding, {
    setupHooks(object: Record<string, unknown>): void {
      if (hooks !== undefined) throw new Error('async_wrap.setupHooks: set once');
      const named = (name: string): Function => {
        const value = object[name];
        if (typeof value !== 'function') throw new TypeError(`async_wrap.setupHooks: ${name} is not a function`);
        return value;
      };
      hooks = { init: named('init'), before: named('before'), after: named('after'), destroy: named('destroy'), promise_resolve: named('promise_resolve') };
    },
    // The trampoline every MakeCallback of a wrap goes through where hooks or the resource are asked for; the
    // engine's callbacks into a wrap are made by its bindings, which keep no AsyncWrap resource of their own.
    setCallbackTrampoline(_fn: unknown): void {},
    pushAsyncContext(asyncId: number, triggerAsyncId: number): void { pushAsyncContext(asyncId, triggerAsyncId); },
    popAsyncContext(asyncId: number): boolean { return popAsyncContext(asyncId); },
    executionAsyncResource(index: number): object | undefined { return nativeResources[index]; },
    clearAsyncIdStack(): void {
      executionAsyncResources.length = 0;
      nativeResources.length = 0;
      asyncIdFields[kExecutionAsyncId] = 0;
      asyncIdFields[kTriggerAsyncId] = 0;
      fields[kStackLength] = 0;
    },
    queueDestroyAsyncId(asyncId: number): void { emitDestroy(Number(asyncId)); },
    setPromiseHooks(init: unknown, before: unknown, after: unknown, resolve: unknown): void {
      promiseHooks = [init, before, after, resolve].map((hook) => (typeof hook === 'function' ? hook : undefined)) as typeof promiseHooks;
    },
    getPromiseHooks(): unknown[] { return [...promiseHooks]; },
    registerDestroyHook(target: object, asyncId: number, propBag?: { destroyed?: unknown }): void {
      destroyRegistry.register(target, { asyncId: Number(asyncId), ...(propBag !== undefined ? { propBag } : {}) });
    },
  });
  return binding;
}
