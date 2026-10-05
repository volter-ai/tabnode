/** Real transports; Node loop references belong to the process using a port. */
import { __reportUncaughtException } from './shims/process';
import { withGuestExecution } from './guest-loop';

type Port = Record<string, any>;
type PortState = { port: Port; referenced: boolean; closed: boolean; close: () => void };
const owned = new WeakMap<object, Set<PortState>>();
const tracked = new WeakMap<object, PortState>();
const globals = new WeakMap<object, { MessageChannel: any; MessagePort: any }>();
const modules = new WeakMap<object, WeakMap<object, object>>();

export function pendingGuestPorts(process: object): number {
  let count = 0;
  for (const state of owned.get(process) ?? []) if (state.referenced && !state.closed) count++;
  return count;
}
export function stopGuestPorts(process: object): void {
  for (const state of [...(owned.get(process) ?? [])]) state.close();
}

function track(process: object, port: Port): Port {
  if (!port || typeof port !== 'object' || typeof port.postMessage !== 'function' || typeof port.close !== 'function' || typeof port.start !== 'function') throw new TypeError('MessagePort method called with an invalid receiver');
  if (tracked.has(port)) return port;
  let entries = owned.get(process);
  if (!entries) { entries = new Set(); owned.set(process, entries); }
  const collection = entries;
  const original: Port = {};
  for (const key of ['ref', 'unref', 'start', 'close', 'on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'removeListener', 'off', 'removeAllListeners', 'addEventListener', 'removeEventListener', 'postMessage', 'emit']) {
    if (typeof port[key] === 'function') original[key] = port[key].bind(port);
  }
  const state: PortState = { port, referenced: false, closed: false, close: () => port.close() };
  tracked.set(port, state);
  collection.add(state);
  const release = () => { state.closed = true; state.referenced = false; collection.delete(state); };
  const define = (key: string, value: unknown) => Object.defineProperty(port, key, { value, writable: true, configurable: true });
  define('ref', () => { if (!state.closed) { state.referenced = true; return original.ref?.(); } });
  define('unref', () => { state.referenced = false; return original.unref?.(); });
  define('hasRef', () => state.closed ? undefined : state.referenced);
  define('close', (callback?: () => void) => {
    if (typeof callback === 'function') port.once('close', callback);
    if (state.closed) return;
    release();
    original.close();
  });
  // Teardown also owns unref'd ports; a host control port is never registered
  // by merely existing, only by passing through a guest constructor/prototype.
  if (original.on) original.on('close', release);
  else original.addEventListener?.('close', release, { once: true });
  original.unref?.();
  state.close = () => { if (state.closed) return; release(); original.close(); };

  const activate = (previous: number, current: number) => {
    if (state.closed) return;
    if (previous === 0 && current > 0) { port.ref(); original.start?.(); }
    else if (previous > 0 && current === 0) port.unref();
  };
  if (original.on && typeof port.listenerCount === 'function') {
    // Account the real delivery boundary without changing listeners or their
    // remove/once identities on the thread host's actual EventEmitter.
    if (original.emit) define('emit', (...args: unknown[]) => withGuestExecution(() => original.emit(...args)));
    // Preserve the thread host's actual EventEmitter and transport semantics.
    for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'removeListener', 'off', 'removeAllListeners']) if (original[name]) {
      define(name, (...args: unknown[]) => {
        const previous = port.listenerCount('message');
        const result = original[name](...args);
        activate(previous, port.listenerCount('message'));
        return result;
      });
    }
    return port;
  }

  // Browser ports retain native identity and transferability. Node's on/once
  // receive data, while EventTarget listeners and onmessage receive the event.
  const listeners = new Map<string, Map<unknown, { capture: boolean; invoke: (event: any) => void }[]>>();
  const count = () => [...(listeners.get('message')?.values() ?? [])].reduce((n, values) => n + values.length, 0);
  const remove = (type: string, listener: unknown, options?: any) => {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const records = listeners.get(type)?.get(listener);
    const record = records?.find(value => value.capture === capture);
    if (!record) return;
    const previous = count();
    records!.splice(records!.indexOf(record), 1);
    if (!records!.length) listeners.get(type)!.delete(listener);
    original.removeEventListener(type, record.invoke, capture);
    activate(previous, count());
  };
  const add = (type: string, listener: any, options?: any, data = false) => {
    if (listener == null || options?.signal?.aborted) return;
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    let byListener = listeners.get(type);
    if (!byListener) { byListener = new Map(); listeners.set(type, byListener); }
    let records = byListener.get(listener);
    if (!records) { records = []; byListener.set(listener, records); }
    if (records.some(record => record.capture === capture)) return;
    const previous = count();
    const invoke = (event: any) => {
      if (options?.once) remove(type, listener, capture);
      if (state.closed && type !== 'close') return;
      try {
        withGuestExecution(() => {
          if (typeof listener === 'function') listener.call(port, data ? event.data : event);
          else listener.handleEvent?.(event);
        });
      } catch (error) { if (!__reportUncaughtException(process, error)) throw error; }
    };
    records.push({ capture, invoke });
    original.addEventListener(type, invoke, options);
    options?.signal?.addEventListener('abort', () => remove(type, listener, capture), { once: true });
    activate(previous, count());
  };
  define('addEventListener', add);
  define('removeEventListener', remove);
  define('on', (type: string, listener: unknown) => { add(type, listener, undefined, true); return port; });
  define('addListener', port.on);
  define('once', (type: string, listener: unknown) => { add(type, listener, { once: true }, true); return port; });
  define('off', (type: string, listener: unknown) => { remove(type, listener); return port; });
  define('removeListener', port.off);
  define('removeAllListeners', (type?: string) => {
    for (const name of type === undefined ? [...listeners.keys()] : [type]) {
      for (const [listener, records] of [...(listeners.get(name)?.entries() ?? [])]) for (const record of [...records]) remove(name, listener, record.capture);
    }
    return port;
  });
  define('listenerCount', (type: string) => [...(listeners.get(type)?.values() ?? [])].reduce((n, values) => n + values.length, 0));
  for (const type of ['message', 'messageerror']) {
    let handler: unknown = null;
    Object.defineProperty(port, 'on' + type, { configurable: true, get: () => handler, set(value) {
      if (handler) remove(type, handler);
      handler = typeof value === 'function' ? value : null;
      if (handler) add(type, handler);
    } });
  }
  return port;
}

function classes(process: object, Channel: any, PortConstructor: any) {
  const MessageChannel = function(this: unknown) {
    if (!new.target) throw new TypeError('MessageChannel must be constructed with new');
    const channel = Reflect.construct(Channel, []) as { port1: Port; port2: Port };
    track(process, channel.port1); track(process, channel.port2);
    return channel;
  };
  const MessagePort = function(this: unknown, ...args: unknown[]) {
    if (!new.target) throw new TypeError('MessagePort must be constructed with new');
    return track(process, Reflect.construct(PortConstructor, args));
  };
  // Borrowed native prototype calls (including emnapi's calls on received
  // ports) get this guest's ownership without changing the host prototype.
  MessagePort.prototype = Object.create(PortConstructor.prototype);
  for (const name of ['ref', 'unref', 'hasRef', 'close', 'on', 'once', 'addListener', 'off', 'removeListener', 'removeAllListeners', 'addEventListener', 'removeEventListener']) {
    Object.defineProperty(MessagePort.prototype, name, { configurable: true, writable: true, value: function(this: Port, ...args: unknown[]) { return track(process, this)[name](...args); } });
  }
  MessageChannel.prototype = Channel.prototype;
  Object.defineProperty(MessagePort, Symbol.hasInstance, { value: (value: unknown) => value instanceof PortConstructor });
  Object.defineProperty(MessageChannel, Symbol.hasInstance, { value: (value: unknown) => value instanceof Channel });
  return { MessageChannel, MessagePort };
}

export function guestMessageGlobals(process: object): { MessageChannel: any; MessagePort: any } {
  let result = globals.get(process);
  if (!result) {
    result = classes(process, globalThis.MessageChannel, globalThis.MessagePort);
    globals.set(process, result);
  }
  return result;
}
export function guestMessageModule(process: object, original: Port, hostTransport = false): object {
  let cache = modules.get(process);
  if (!cache) { cache = new WeakMap(); modules.set(process, cache); }
  let result = cache.get(original);
  if (!result) {
    result = { ...original, ...(hostTransport ? guestMessageGlobals(process) : classes(process, original.MessageChannel, original.MessagePort)) };
    (result as Port).default = result;
    cache.set(original, result);
  }
  return result;
}
