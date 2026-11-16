/**
 * `internalBinding('messaging')` (ADR-0018 item 9): Node v24.21.0's src/node_messaging.cc split where V8 stands. A
 * MessagePort is the one HandleWrap (`handle_wrap.ts`) over native/node's uv_async_t (node_messaging.c), initialized
 * when it is made, as MessagePort's constructor CHECKs uv_async_init; `close`, `ref`, `unref` and `hasRef` are
 * HandleWrap's. Its V8 half is here: MessagePortData (its queue and its sibling group), SiblingGroup (MessageChannel's
 * two ports, BroadcastChannel's named group) and Message (a value serialized with its transfers). A message's arrival
 * is TriggerAsync, the program's uv_async_send, and libuv's callback is OnMessage, whose turns are the program's
 * `message_port_pending` and `message_port_message` imports, each message's callback closed by a drain. So whether a
 * port holds the process is libuv's: its uv_async_t is active until it is closed, and Node's own
 * `lib/internal/worker/io.js` (vendored unchanged) refs it while it has a `message` listener and unrefs it with the
 * last (setupPortReferencing); MessageChannel, MessagePort and BroadcastChannel are that file's, over this binding.
 *
 * Where it is not Node's C++:
 * - A message's value is serialized by the realm's structured clone (HTML's, the serialization V8's ValueSerializer
 *   carries), not by V8's ValueSerializer: a value goes to the receiver as `structuredClone` copies it. Node's
 *   delegate's host objects are found by a walk of the value's objects, arrays, maps and sets, as the serializer
 *   reaches them: a MessagePort is written as its index among the message's transfers (the walk stands a placeholder
 *   there, and the receiver's port takes the placeholder's place), with Node's errors for one not transferred or
 *   detached.
 * - A JS transferable (an object carrying the transfer mode, lib/internal/worker/js_transferable.js) is Node's
 *   delegate's host object; the engine's `internal/worker/js_transferable` marks none (its `markTransferMode` is the
 *   engine's), so the one mode an object carries is `markAsUncloneable`'s none, which Node refuses.
 * - A process has one realm and no worker threads, so every message's poster is the process's own thread, and
 *   MessagePortData's mutex has nothing to order; `moveMessagePortToContext` moves a port into the realm's one context,
 *   the context every `vm` sandbox of the engine is (shims/vm.ts `isContext`).
 * A realm the host gives no `node` program has no libuv: there a port is the engine's (guest-message-ports.ts), and
 * this binding answers only `DOMException`.
 */
import { libnode, type HandleCallbacks } from './libnode';
import { HandleWrap } from './handle_wrap';
import { ownedRun, ownerOfInstance, type OwnedHandle } from './handles';
import { nextHandleAsyncId } from './stream_wrap';
import { utilBinding } from './util';
import { internalUtilTypes as types } from '../internals/util';

/** `internalBinding('symbols')`'s names io.js reads (src/env_properties.h PER_ISOLATE_SYMBOL_PROPERTIES). */
export const messagingSymbols = {
  handle_onclose: Symbol('handle_onclose'),
  oninit: Symbol('oninit'),
  no_message_symbol: Symbol('no_message_symbol'),
};
const { handle_onclose: kOnClose, oninit: kOnInit, no_message_symbol: noMessage } = messagingSymbols;
const { untransferable_object_private_symbol: kUntransferable, transfer_mode_private_symbol: kTransferMode } =
  utilBinding.privateSymbols;

/** `internalBinding('worker')` as io.js reads it: the main thread's Environment has no parent's port. */
export const workerBinding = {
  getEnvMessagePort: (): undefined => undefined,
};

// src/env_properties.h's strings and src/node_errors.h's codes.
const CLONE_UNSUPPORTED = 'Cannot clone object of unsupported type.';
const CLONE_TRANSFER_NEEDED = 'Object that needs transfer was found in message but not listed in transferList';
const CLONE_UNTRANSFERABLE = 'Found invalid value in transferList.';
const TRANSFER_UNSUPPORTED = 'Cannot transfer object of unsupported type.';
const dataCloneError = (message: string): Error => new DOMException(message, 'DataCloneError');
/**
 * The realm's own structured clone, taken when the engine loads: where the realm's process is `node`, the global
 * `structuredClone` is Node's (`internal/worker/js_transferable`), which is this binding's.
 */
const realmStructuredClone: typeof structuredClone = globalThis.structuredClone.bind(globalThis);
const nodeError = (Base: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error =>
  Object.assign(new Base(message), { code });
const invalidArgType = (message: string): Error => nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', message);

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const tagOf = (value: object): string => Object.prototype.toString.call(value);
const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');
/** An object the structured clone writes as an ordinary one: its own enumerable string-keyed properties. */
const isOrdinary = (value: object): boolean =>
  !Array.isArray(value) && !types.isProxy(value) && tagOf(value) === '[object Object]';

/** Every port object the binding made (MessagePort's constructor template's HasInstance). */
const portObjects = new WeakSet<object>();
/** A port object's MessagePort while it is wrapped: BaseObject::Unwrap, null once OnClose detached it. */
const wraps = new WeakMap<object, PortWrap>();

/** A Message (node_messaging.h): its value as serialized, the ports it transfers; none of either is a close message. */
class Message {
  /** The clone: the value, and the placeholder standing for each transferred port in it. */
  graph: { value: unknown; hosts: object[] } | undefined;
  transferables: MessagePortData[] = [];
  /** The ports it was queued to and has not been read by (SiblingGroup::Dispatch shares one message among them). */
  unread = 0;
  get isClose(): boolean { return this.graph === undefined; }
}

/**
 * Message::Serialize (node_messaging.cc:476-616): the transfer list's checks, the value's serialization with its host
 * objects, then its ArrayBuffers detached and its ports transferred (each closed and its queue taken).
 */
function serialize(message: Message, input: unknown, transferList: readonly unknown[], sourcePort: object | undefined): void {
  const buffers: ArrayBuffer[] = [];
  const hosts: PortWrap[] = [];
  for (const entry of transferList) {
    if (!isObject(entry)) throw dataCloneError(CLONE_UNTRANSFERABLE);
    if (hasOwn(entry, kUntransferable)) throw dataCloneError(TRANSFER_UNSUPPORTED);
    if (types.isArrayBuffer(entry)) {
      const buffer = entry as ArrayBuffer & { detached?: boolean };
      if (buffer.detached === true) throw dataCloneError(TRANSFER_UNSUPPORTED);
      if (buffers.includes(buffer)) throw dataCloneError('Transfer list contains duplicate ArrayBuffer');
      buffers.push(buffer);
      continue;
    }
    if (sourcePort !== undefined && entry === sourcePort) throw dataCloneError('Transfer list contains source port');
    const port = wraps.get(entry);
    if (portObjects.has(entry) && (port === undefined || port.isDetached())) {
      throw dataCloneError('MessagePort in transfer list is already detached');
    }
    if (port !== undefined && hosts.includes(port)) {
      throw dataCloneError(`Transfer list contains duplicate ${(entry as { constructor?: { name?: string } }).constructor?.name ?? 'Object'}`);
    }
    // A MessagePort is kTransferable; a JS transferable's mode is none here (the header's second point).
    if (port === undefined) throw dataCloneError(CLONE_UNTRANSFERABLE);
    hosts.push(port);
  }

  // The serializer's walk, and SerializerDelegate::WriteHostObject at each host object it reaches.
  const placeholders: object[] = [];
  const copies = new Map<object, unknown>();
  const write = (value: unknown): unknown => {
    if (!isObject(value)) return value;
    if (copies.has(value)) return copies.get(value);
    if (portObjects.has(value)) {
      const port = wraps.get(value);
      if (port === undefined || port.isDetached()) throw dataCloneError(CLONE_UNSUPPORTED);
      const index = hosts.indexOf(port);
      if (index < 0) throw dataCloneError(CLONE_TRANSFER_NEEDED);
      const placeholder = placeholders[index] ??= {};
      copies.set(value, placeholder);
      return placeholder;
    }
    if (hasOwn(value, kTransferMode)) throw dataCloneError(CLONE_UNSUPPORTED);
    if (Array.isArray(value)) {
      const copy: unknown[] = new Array(value.length);
      copies.set(value, copy);
      for (const key of Object.keys(value)) (copy as unknown as Record<string, unknown>)[key] = write((value as unknown as Record<string, unknown>)[key]);
      return copy;
    }
    if (types.isMap(value)) {
      const copy = new Map<unknown, unknown>();
      copies.set(value, copy);
      for (const [key, entry] of [...Map.prototype.entries.call(value)]) copy.set(write(key), write(entry));
      return copy;
    }
    if (types.isSet(value)) {
      const copy = new Set<unknown>();
      copies.set(value, copy);
      for (const entry of [...Set.prototype.values.call(value)]) copy.add(write(entry));
      return copy;
    }
    if (typeof value === 'object' && isOrdinary(value)) {
      const copy: Record<string, unknown> = {};
      copies.set(value, copy);
      for (const key of Object.keys(value)) copy[key] = write((value as Record<string, unknown>)[key]);
      return copy;
    }
    // A function, a Proxy, a Date, a buffer, an Error, a platform object: the realm's serializer's own, which copies
    // or refuses each as V8's does.
    return value;
  };
  const value = write(input);
  for (let index = 0; index < hosts.length; index++) placeholders[index] ??= {};
  message.graph = realmStructuredClone({ value, hosts: placeholders }, { transfer: buffers });
  // SerializerDelegate::Finish: each port transferred, MessagePort::TransferForMessaging.
  message.transferables = hosts.map((port) => port.transferForMessaging());
}

/** A message's clone, its placeholders replaced by `hosts` (DeserializerDelegate::ReadHostObject). */
function restore(graph: { value: unknown; hosts: object[] }, hosts: readonly object[]): unknown {
  if (hosts.length === 0) return graph.value;
  const index = new Map<object, number>(graph.hosts.map((placeholder, at) => [placeholder, at]));
  const visited = new Set<object>();
  const read = (value: unknown): unknown => {
    if (!isObject(value)) return value;
    const at = index.get(value);
    if (at !== undefined) return hosts[at];
    if (visited.has(value)) return value;
    visited.add(value);
    if (Array.isArray(value) || isOrdinary(value)) {
      const fields = value as Record<string, unknown>;
      for (const key of Object.keys(fields)) fields[key] = read(fields[key]);
    } else if (value instanceof Map) {
      const entries = [...value];
      value.clear();
      for (const [key, entry] of entries) value.set(read(key), read(entry));
    } else if (value instanceof Set) {
      const entries = [...value];
      value.clear();
      for (const entry of entries) value.add(read(entry));
    }
    return value;
  };
  return read(graph.value);
}

/**
 * Message::Deserialize (node_messaging.cc:139-231): a port for each transferred queue, listed in `portList` where one is
 * asked for, then the value. A message queued to more than one port is read by each as its own copy, as each of
 * Node's receivers reads it from its bytes.
 */
function deserialize(message: Message, binding: Binding, portList?: { ports?: object[] }): unknown {
  const hosts = message.transferables.map((data) => newPort(binding, data).object);
  message.transferables = [];
  if (portList !== undefined && hosts.length > 0) portList.ports = hosts;
  const graph = message.graph!;
  message.unread -= 1;
  return restore(message.unread > 0 ? realmStructuredClone(graph) : graph, hosts);
}

/** A SiblingGroup (node_messaging.cc:1564-1665): the ports a message posted to one of them reaches. */
class SiblingGroup {
  static readonly named = new Map<string, SiblingGroup>();
  readonly ports = new Set<MessagePortData>();
  constructor(readonly name = '') {}

  /** SiblingGroup::Get: the live group of the name, or a new one. */
  static get(name: string): SiblingGroup {
    let group = SiblingGroup.named.get(name);
    if (!group) { group = new SiblingGroup(name); SiblingGroup.named.set(name, group); }
    return group;
  }

  /** SiblingGroup::Dispatch: true where sent, false where no port is there to receive it, undefined where refused. */
  dispatch(source: MessagePortData, message: Message, error: { text: string }): boolean | undefined {
    if (!this.ports.has(source)) { error.text = 'Source MessagePort is not entangled with this group.'; return undefined; }
    if (this.ports.size <= 1) return false;
    if (this.ports.size > 2 && message.transferables.length > 0) {
      error.text = 'Transferables cannot be used with multiple destinations.';
      return undefined;
    }
    for (const port of this.ports) {
      if (port === source) continue;
      if (message.transferables.includes(port)) {
        error.text = 'The target port was posted to itself, and the communication channel was lost';
        return true;
      }
      message.unread += 1;
      port.addToIncomingQueue(message);
    }
    return true;
  }

  entangle(...ports: MessagePortData[]): void {
    for (const data of ports) { this.ports.add(data); data.group = this; }
  }

  /** SiblingGroup::Disentangle: the port's close message, and its sole sibling's in an anonymous group. */
  disentangle(data: MessagePortData): void {
    this.ports.delete(data);
    data.group = null;
    data.addToIncomingQueue(new Message());
    if (this.ports.size === 1 && this.name === '') [...this.ports][0]!.addToIncomingQueue(new Message());
    // ~SiblingGroup's CheckSiblingGroup: a named group nobody holds is gone.
    if (this.ports.size === 0 && this.name !== '' && SiblingGroup.named.get(this.name) === this) SiblingGroup.named.delete(this.name);
  }
}

/** MessagePortData (node_messaging.cc:625-660): a port's queue and group, which a transfer carries to its new port. */
class MessagePortData {
  readonly incoming: Message[] = [];
  group: SiblingGroup | null = null;
  constructor(public owner: PortWrap | null) {}

  /** AddToIncomingQueue: queued, and its owner's uv_async_t sent. */
  addToIncomingQueue(message: Message): void {
    this.incoming.push(message);
    this.owner?.triggerAsync();
  }

  disentangle(): void { this.group?.disentangle(this); }

  dispatch(message: Message, error: { text: string }): boolean | undefined {
    if (!this.group) { error.text = 'MessagePortData is not entangled.'; return undefined; }
    return this.group.dispatch(this, message, error);
  }
}

type PortList = { ports?: object[] };

/** The C++ MessagePort: the HandleWrap over the port's uv_async_t, and its MessagePortData. */
class PortWrap implements OwnedHandle, HandleCallbacks {
  readonly handle: HandleWrap;
  data: MessagePortData | null = new MessagePortData(this);
  receiving = false;
  readonly asyncId = nextHandleAsyncId();

  constructor(readonly object: object, readonly binding: Binding) {
    this.handle = new HandleWrap(this, this, libnode().exports.tabnode_message_port_new(), true);
    wraps.set(object, this);
  }

  /** HandleWrap::IsHandleClosing: closing or closed. */
  get handleClosing(): boolean { return !this.handle.alive || this.handle.closing; }
  /** MessagePort::IsDetached. */
  isDetached(): boolean { return this.data === null || this.handleClosing; }

  triggerAsync(): void {
    if (this.handleClosing) return;
    libnode().exports.tabnode_message_port_trigger(this.handle.wrap);
  }

  /**
   * MessagePort::Close, HandleWrap::Close (handle_wrap.cc:72-86): a function given becomes the object's
   * `handle_onclose`; OnClose makes the object's `handle_onclose` where it has one (io.js's `onclose` on the prototype).
   */
  close(callback?: unknown): void {
    if (this.handle.closing || !this.handle.alive) return;
    const object = this.object as Record<symbol, unknown>;
    if (typeof callback === 'function') object[kOnClose] = callback;
    this.handle.close(kOnClose in object ? () => { (object[kOnClose] as () => void).call(object); } : undefined);
  }

  /** MessagePort::Detach: the queue taken from the port. */
  detach(): MessagePortData {
    const data = this.data!;
    data.owner = null;
    this.data = null;
    return data;
  }

  /** MessagePort::TransferForMessaging. */
  transferForMessaging(): MessagePortData {
    this.close();
    return this.detach();
  }

  /** HandleWrap::OnClose's Detach, then MessagePort::OnClose: the queue leaves its group. */
  onUvClose(): void {
    wraps.delete(this.object);
    if (this.data) this.detach().disentangle();
  }

  onUvMessagePending(): number {
    if (this.isDetached()) return -1;
    return Math.max(this.data!.incoming.length, 1000);
  }

  onUvMessage(): number { return this.turn(false); }

  /** MessagePort::ReceiveMessage (node_messaging.cc:767-810). */
  receiveMessage(force: boolean, portList?: PortList): unknown {
    const data = this.data;
    if (data === null) return noMessage;
    const front = data.incoming[0];
    if (front === undefined || (!(this.receiving || force) && !front.isClose)) return noMessage;
    data.incoming.shift();
    if (front.isClose) { this.close(); return noMessage; }
    return deserialize(front, this.binding, portList);
  }

  /**
   * One turn of MessagePort::OnMessage's loop (node_messaging.cc:842-890): ReceiveMessage, then MakeCallback of
   * `emitMessage` on the port's object; a message that cannot be read is the port's `messageerror`, and a failed turn
   * asks for the next (TriggerAsync).
   */
  turn(force: boolean): number {
    if (this.data === null) return 0;
    const portList: PortList = {};
    let payload: unknown;
    let messageError: { error: unknown } | undefined;
    try { payload = this.receiveMessage(force, portList); } catch (error) { messageError = { error }; }
    if (messageError === undefined) {
      if (payload === noMessage) return 0;
      if (this.emit(payload, portList.ports, 'message')) return 1;
    } else {
      this.emit(messageError.error, undefined, 'messageerror');
    }
    if (this.data) this.triggerAsync();
    return 2;
  }

  /** MakeCallback(emit_message, [payload, port list, type]) in the port's run: whether it returned. */
  private emit(payload: unknown, ports: object[] | undefined, type: string): boolean {
    const emitMessage = this.binding.emitMessage();
    let returned = false;
    ownedRun(ownerOfInstance(this), () => { emitMessage.call(this.object, payload, ports, type); returned = true; }, true, 'wrap', emitMessage);
    return returned;
  }

  /** MessagePort::PostMessage (node_messaging.cc:924-955): the warning a dispatch leaves, its answer. */
  postMessage(value: unknown, transferList: readonly unknown[]): boolean | undefined {
    const message = new Message();
    serialize(message, value, transferList, this.object);
    if (this.data === null) return true;
    const error = { text: '' };
    const sent = this.data.dispatch(message, error);
    if (sent === undefined) return undefined;
    if (error.text) this.binding.emitWarning(error.text);
    return sent;
  }
}

/** ReadIterable (node_messaging.cc:968-1040): an array's elements or an iterable's values; false for neither. */
function readIterable(value: unknown): unknown[] | false {
  if (!isObject(value)) return false;
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => value[index]);
  const method = (value as Record<symbol, unknown>)[Symbol.iterator];
  if (typeof method !== 'function') return false;
  const iterator = method.call(value) as unknown;
  if (!isObject(iterator)) return false;
  const next = (iterator as { next?: unknown }).next;
  if (typeof next !== 'function') return false;
  const entries: unknown[] = [];
  for (;;) {
    const result = next.call(iterator) as unknown;
    if (!isObject(result)) return false;
    if ((result as { done?: unknown }).done) break;
    entries.push((result as { value?: unknown }).value);
  }
  return entries;
}

/** GetTransferList (node_messaging.cc:1042-1080). */
function getTransferList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!isObject(value)) throw invalidArgType('Optional transferList argument must be an iterable');
  const list = readIterable(value);
  if (list !== false) return list;
  const option = (value as { transfer?: unknown }).transfer;
  if (option === undefined) return [];
  const transfer = readIterable(option);
  if (transfer === false) throw invalidArgType('Optional options.transfer argument must be an iterable');
  return transfer;
}

/** What a port's MakeCallback and its warnings reach in the graph that made the binding. */
interface Binding {
  readonly MessagePort: { prototype: object };
  emitMessage(): (this: object, data: unknown, ports: object[] | undefined, type: string) => void;
  emitWarning(text: string): void;
}

/**
 * MessagePort::New (node_messaging.cc:713-765): an instance of the constructor's template (no JavaScript constructor
 * runs), its uv_async_t, its `oninit`; given a queue, the port takes it and runs it; given a group, joins it.
 */
function newPort(binding: Binding, data?: MessagePortData, group?: SiblingGroup): PortWrap {
  const object = Object.create(binding.MessagePort.prototype) as Record<symbol, unknown>;
  portObjects.add(object);
  const port = new PortWrap(object, binding);
  const init = object[kOnInit];
  if (typeof init === 'function') {
    try { init.call(object); } catch (error) { port.close(); throw error; }
  }
  if (data) {
    port.detach();
    port.data = data;
    data.owner = port;
    port.triggerAsync();
  } else if (group) {
    group.entangle(port.data!);
  }
  return port;
}

/** A port object's MessagePort, as ASSIGN_OR_RETURN_UNWRAP finds it. */
const unwrap = (object: unknown): PortWrap | undefined => (isObject(object) ? wraps.get(object) : undefined);

/** The binding of one graph: its MessagePort constructor, whose prototype Node's io.js reshapes, is that graph's. */
/**
 * `perContext` is the realm's per-context exports where Node's bootstrap made them (realm.ts, ADR-0018 §7): Node's
 * binding takes `emitMessage` from them (src/node_messaging.cc, GetEmitMessageFunction), not from a require.
 */
export function createMessagingBinding(require?: (name: string) => any, perContext?: { emitMessage?: unknown }) {
  if (!require) return { get DOMException() { return globalThis.DOMException; } };
  // HandleWrap's and AsyncWrap's prototype methods (handle_wrap.cc:40-86), which MessagePort's template inherits.
  const handleWrapPrototype = {
    close(this: object, callback?: unknown): void { unwrap(this)?.close(callback); },
    ref(this: object): void { const port = unwrap(this); if (port?.handle.alive) port.handle.ref(); },
    unref(this: object): void { const port = unwrap(this); if (port?.handle.alive) port.handle.unref(); },
    hasRef(this: object): boolean | undefined { const port = unwrap(this); return port === undefined ? undefined : port.handle.hasRef(); },
    getAsyncId(this: object): number | undefined { return unwrap(this)?.asyncId; },
  };
  // MessagePort::New, the JavaScript constructor: it throws (ERR_CONSTRUCT_CALL_INVALID), as Node's does.
  const MessagePort = function MessagePort(): never {
    throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
  } as unknown as { prototype: object };
  MessagePort.prototype = Object.create(handleWrapPrototype, {
    constructor: { value: MessagePort, writable: true, configurable: true },
    /** MessagePort::PostMessage (node_messaging.cc:1082-1115). */
    postMessage: {
      writable: true, enumerable: true, configurable: true,
      value: function postMessage(this: object, ...args: unknown[]): boolean | undefined {
        if (args.length === 0) throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'Not enough arguments to MessagePort.postMessage');
        const transferList = getTransferList(args[1]);
        const port = unwrap(this);
        // A closed port still serializes, so its transfers are made as the spec has them.
        if (port === undefined || port.handleClosing) { serialize(new Message(), args[0], transferList, this); return undefined; }
        return port.postMessage(args[0], transferList);
      },
    },
    /** MessagePort::Start (node_messaging.cc:1117-1143). */
    start: {
      writable: true, enumerable: true, configurable: true,
      value: function start(this: object): void {
        const port = unwrap(this);
        if (!port?.data) return;
        port.receiving = true;
        if (port.data.incoming.length > 0) port.triggerAsync();
      },
    },
  });
  let emitMessage: ReturnType<Binding['emitMessage']> | undefined;
  const binding: Binding = {
    MessagePort,
    emitMessage: () => emitMessage ??= (perContext ?? require('internal/per_context/messageport') as { emitMessage: ReturnType<Binding['emitMessage']> }).emitMessage as ReturnType<Binding['emitMessage']>,
    emitWarning: (text) => { (require('process') as { emitWarning(text: string): void }).emitWarning(text); },
  };
  const portArgument = (value: unknown): object => {
    if (!isObject(value) || !portObjects.has(value)) throw invalidArgType('The "port" argument must be a MessagePort instance');
    return value;
  };

  return {
    get DOMException() { return globalThis.DOMException; },
    MessagePort,
    /** MessageChannel (node_messaging.cc:1708-1741): two ports entangled in an anonymous group. */
    MessageChannel: function MessageChannel(this: Record<string, unknown>): void {
      if (!new.target) throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_REQUIRED', 'Cannot call constructor without `new`');
      const port1 = newPort(binding);
      let port2: PortWrap;
      try { port2 = newPort(binding); } catch (error) { port1.close(); throw error; }
      new SiblingGroup().entangle(port1.data!, port2.data!);
      this.port1 = port1.object;
      this.port2 = port2.object;
    },
    /** BroadcastChannel (node_messaging.cc:1743-1753): a port in the named group. */
    broadcastChannel: (name: unknown): object => newPort(binding, undefined, SiblingGroup.get(String(name))).object,
    /** MessagePort::Stop (node_messaging.cc:1145-1153). */
    stopMessagePort: (object: unknown): void => {
      const port = unwrap(object);
      if (port?.data) port.receiving = false;
    },
    /** MessagePort::Drain (node_messaging.cc:1155-1159): OnMessage(kForceReadMessages), inside the caller's call. */
    drainMessagePort: (object: unknown): void => {
      const port = unwrap(object);
      if (port === undefined || port.isDetached()) return;
      while (port.turn(true) === 1);
    },
    /** MessagePort::ReceiveMessage (node_messaging.cc:1161-1184): `no_message_symbol` for a closed port. */
    receiveMessageOnPort: (object: unknown): unknown => {
      const port = unwrap(portArgument(object));
      if (port === undefined) return noMessage;
      return port.receiveMessage(true);
    },
    /** MessagePort::MoveToContext (node_messaging.cc:1186-1215), into the realm's one context. */
    moveMessagePortToContext: (object: unknown, context: unknown): object => {
      const port = unwrap(portArgument(object));
      if (port === undefined || port.handleClosing) {
        throw nodeError(Error, 'ERR_CLOSED_MESSAGE_PORT', 'Cannot send data on closed MessagePort');
      }
      if (!isObject(context)) throw invalidArgType('Invalid context argument');
      return newPort(binding, port.isDetached() ? undefined : port.detach()).object;
    },
    /** StructuredClone (node_messaging.cc:1680-1706): a Message serialized and read at once. */
    structuredClone: (value: unknown, options: unknown): unknown => {
      const transfer = (options as { transfer?: unknown[] } | undefined)?.transfer ?? [];
      const message = new Message();
      serialize(message, value, Array.from(transfer), undefined);
      message.unread = 1;
      return deserialize(message, binding);
    },
    /** ExposeLazyDOMExceptionProperty (node_messaging.cc:1765-1786): `DOMException`, made on its first read. */
    exposeLazyDOMExceptionProperty: (target: object): void => {
      Object.defineProperty(target, 'DOMException', {
        configurable: true, enumerable: false,
        get: () => globalThis.DOMException,
        set(value) { Object.defineProperty(target, 'DOMException', { value, writable: true, configurable: true, enumerable: false }); },
      });
    },
  };
}
