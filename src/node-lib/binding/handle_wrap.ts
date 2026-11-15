/**
 * Node's `HandleWrap` (src/handle_wrap.cc, Node v24.21.0) over the program's libuv (ADR-0018 §3): the object a
 * binding's handle is, holding its state (`state_`) and its uv_handle_t's address in the process's memory (`handle_`),
 * with `close`, `ref`, `unref` and `hasRef` as Node's, each the libuv call of native/node's handle_wrap.c once the
 * state allows it. A handle is kept while it is open, as Node keeps an open HandleWrap's object; once closed it may
 * be collected, and its memory is freed then, as Node's BaseObject is.
 *
 * The engine still decides a run's end by its own count of the run's handles (ADR-0018 item 2), so each handle is
 * also in that count (`handles.ts`), told what libuv's handle does: started, stopped, ref'd, unref'd, closed.
 */
import { address, libnode } from '../../libnode';
import { nextHandleAsyncId } from './stream_wrap';
import {
  registerHandle, refHandle, unrefHandle, releaseHandle, observeNodeHandle, ownedRun, ownerOfInstance, type OwnedHandle,
} from './handles';

/** The uv_handle_t's address in the process's memory (Node's `handle_`). */
export const kHandle = Symbol('kHandle');
/** The close callback `close` was given (Node's `handle_onclose_symbol`). */
const kOnClose = Symbol('handle_onclose');

/** HandleWrap's `state_`. */
const enum State { Initialized, Closing, Closed }

/** Each initialized handle by its address, for the program's callbacks to find: kept until closed, as Node's is. */
const open = new Map<number, HandleWrap>();
/** A handle's memory, freed once its object is collected where libuv no longer holds it (never initialized, or closed). */
const collected = new FinalizationRegistry<{ handle: number; released: boolean }>(({ handle, released }) => {
  if (released) libnode().exports.tabnode_free(handle);
});

export class HandleWrap implements OwnedHandle {
  readonly [kHandle]: number;
  private state: State;
  private [kOnClose]: unknown;
  private readonly memory: { handle: number; released: boolean };
  private readonly asyncId = nextHandleAsyncId();

  /**
   * HandleWrap's constructor over the uv_handle_t the subclass's C made (`handle`): initialized, or, as Node's
   * ProcessWrap marks itself, not until a call makes it so (`markAsInitialized`). `active` says whether it holds its
   * run from its start (the engine's count, `handles.ts`).
   */
  protected constructor(handle: number, initialized: boolean, active: boolean) {
    handle = address(handle);
    if (handle === 0) throw new RangeError('node: out of memory for a handle');
    this[kHandle] = handle;
    this.memory = { handle, released: true };
    collected.register(this, this.memory);
    this.state = State.Closed;
    registerHandle(this, false, active);
    if (initialized) this.markAsInitialized();
  }

  /** HandleWrap::MarkAsInitialized. */
  protected markAsInitialized(): void {
    this.state = State.Initialized;
    this.memory.released = false;
    open.set(this[kHandle], this);
    observeNodeHandle(this);
  }

  /** HandleWrap::IsAlive. */
  private alive(): boolean {
    return this.state !== State.Closed;
  }

  getAsyncId(): number {
    return this.asyncId;
  }

  ref(): void {
    if (!this.alive()) return;
    libnode().exports.tabnode_handle_ref(this[kHandle]);
    refHandle(this);
  }

  unref(): void {
    if (!this.alive()) return;
    libnode().exports.tabnode_handle_unref(this[kHandle]);
    unrefHandle(this);
  }

  hasRef(): boolean {
    return this.alive() && libnode().exports.tabnode_handle_has_ref(this[kHandle]) !== 0;
  }

  /** HandleWrap::Close (handle_wrap.cc:72-83). */
  close(callback?: unknown): void {
    if (this.state !== State.Initialized) return;
    libnode().exports.tabnode_handle_close(this[kHandle]);
    this.state = State.Closing;
    if (typeof callback === 'function') this[kOnClose] = callback;
  }

  /** HandleWrap::OnClose (handle_wrap.cc:135-157): answers whether it made the close callback. */
  static closed(handle: number): boolean {
    const wrap = open.get(address(handle));
    if (!wrap) throw new Error(`node: libuv closed a handle no wrap holds (${address(handle)})`);
    open.delete(wrap[kHandle]);
    wrap.memory.released = true;
    wrap.state = State.Closed;
    releaseHandle(wrap);
    const callback = wrap[kOnClose];
    if (typeof callback !== 'function') return false;
    ownedRun(ownerOfInstance(wrap), () => (callback as () => unknown).call(wrap), true, 'wrap', callback);
    return true;
  }

  /** The open handle at `handle`, for a callback of its kind. */
  static at<T extends HandleWrap>(handle: number, kind: abstract new (...args: never[]) => T): T {
    const wrap = open.get(address(handle));
    if (!(wrap instanceof kind)) throw new Error(`node: libuv called back a handle no ${kind.name} holds (${address(handle)})`);
    return wrap;
  }
}

/**
 * LibuvStreamWrap::From(handle)->stream() (src/process_wrap.cc StreamForWrap): the uv_stream_t of a stream handle
 * (a Pipe, a TTY, a TCP), which Node CHECKs is there.
 */
export function uvStreamOf(handle: unknown): number {
  const stream = handle instanceof HandleWrap ? handle[kHandle] : 0;
  if (stream === 0) throw new TypeError('CHECK_NOT_NULL(stream): a stdio handle is not a libuv stream');
  return stream;
}

