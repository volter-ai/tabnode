/**
 * worker_threads shim - Worker threads API
 * Stub implementation for browser environment
 */

import { EventEmitter } from '../node-lib/events-module';

export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;

export class Worker extends EventEmitter {
  threadId = 0;
  resourceLimits = {};

  constructor(filename: string, options?: { workerData?: unknown }) {
    super();
    // A guest that reaches worker_threads must fail loudly rather than get a
    // Worker that silently never runs: the execution-worker bridge handles the
    // lanes we do support, and everything else refuses here.
    throw Object.assign(new Error("Node worker_threads execution is not supported by this browser Node pack."), { code: "ERR_WORKER_UNSUPPORTED" });
  }

  postMessage(value: unknown, transferList?: unknown[]): void {
    // No-op
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  ref(): void {}
  unref(): void {}

  getHeapSnapshot(): Promise<unknown> {
    return Promise.resolve({});
  }
}

export class MessageChannel {
  port1 = new MessagePort();
  port2 = new MessagePort();
}

export class MessagePort extends EventEmitter {
  postMessage(value: unknown, transferList?: unknown[]): void {
    // No-op
  }

  start(): void {}
  close(): void {}
  ref(): void {}
  unref(): void {}
}

export class BroadcastChannel extends EventEmitter {
  name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }

  postMessage(message: unknown): void {
    // No-op in single-threaded environment
  }

  close(): void {}
  ref(): void {}
  unref(): void {}
}

export function moveMessagePortToContext(
  port: MessagePort,
  contextifiedSandbox: unknown
): MessagePort {
  return port;
}

export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined {
  return undefined;
}

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

export function markAsUntransferable(object: unknown): void {
  // No-op
}

/**
 * Node 22's `markAsUncloneable` and its query: an object so marked is refused
 * by `structuredClone` and `postMessage`. undici's WebIDL layer marks every
 * `CacheStorage`, `Request` and `Response` it makes, at construction, so a
 * program that loads undici 7.x+ or 8.x died on `markAsUncloneable is not a
 * function` before its first line. The mark is kept; this engine's message
 * channels do not yet read it, so a marked object that is posted is copied
 * rather than refused.
 */
const uncloneable = new WeakSet<object>();
export function markAsUncloneable(object: unknown): void {
  if (object !== null && (typeof object === 'object' || typeof object === 'function')) uncloneable.add(object as object);
}
export function isMarkedAsUncloneable(object: unknown): boolean {
  return object !== null && (typeof object === 'object' || typeof object === 'function') && uncloneable.has(object as object);
}

export function getEnvironmentData(key: unknown): unknown {
  return undefined;
}

export function setEnvironmentData(key: unknown, value: unknown): void {
  // No-op
}

export default {
  isMainThread,
  parentPort,
  workerData,
  threadId,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  moveMessagePortToContext,
  receiveMessageOnPort,
  SHARE_ENV,
  markAsUntransferable,
  markAsUncloneable,
  isMarkedAsUncloneable,
  getEnvironmentData,
  setEnvironmentData,
};
