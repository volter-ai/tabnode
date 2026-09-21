/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * cluster shim - Clustering is not available in browser
 */

import { EventEmitter } from '../node-lib/events-module';

export const isMaster = true;
export const isPrimary = true;
export const isWorker = false;

export class Worker extends EventEmitter {
  id = 0;
  process = null;
  send(_message: unknown, _callback?: (error: Error | null) => void): boolean {
    return false;
  }
  kill(_signal?: string): void {}
  disconnect(): void {}
  isDead(): boolean { return false; }
  isConnected(): boolean { return false; }
}

export const worker: Worker | null = null;
export const workers: Record<number, Worker> = {};

export function fork(_env?: object): Worker {
  return new Worker();
}

export function disconnect(_callback?: () => void): void {
  if (_callback) setTimeout(_callback, 0);
}

export const settings = {};
export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export let schedulingPolicy = SCHED_RR;

export function setupMaster(_settings?: object): void {}
export function setupPrimary(_settings?: object): void {}

/**
 * The emitter a `cluster` is, built on the first listener rather than when
 * this file is evaluated. `EventEmitter` is a name that stands for Node's own
 * class until the loader can build it, and constructing one at module scope
 * forces that load while the module graph is still being evaluated -- which
 * is a cycle the loader is inside of, and there is no first member of it.
 */
// eslint-disable-next-line no-var, vars-on-top
var clusterEmitterCache: EventEmitter | undefined;
function clusterEmitter(): EventEmitter {
  return clusterEmitterCache ??= new EventEmitter();
}
export const on = (event: string, listener: (...args: any[]) => void): unknown => clusterEmitter().on(event, listener);
export const once = (event: string, listener: (...args: any[]) => void): unknown => clusterEmitter().once(event, listener);
export const emit = (event: string, ...args: unknown[]): boolean => clusterEmitter().emit(event, ...args);
export const removeListener = (event: string, listener: (...args: any[]) => void): unknown => clusterEmitter().removeListener(event, listener);

export default {
  isMaster,
  isPrimary,
  isWorker,
  Worker,
  worker,
  workers,
  fork,
  disconnect,
  settings,
  SCHED_NONE,
  SCHED_RR,
  schedulingPolicy,
  setupMaster,
  setupPrimary,
  on,
  once,
  emit,
  removeListener,
};
