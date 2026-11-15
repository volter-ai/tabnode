/**
 * Node's HandleWrap (src/handle_wrap.cc, Node v24.21.0) over a uv_handle_t of the process's (ADR-0018 §3): the one
 * core every binding's handle has where the realm's process is `node` on libuv's loop, a TCP, a Pipe, a TTY, a UDP
 * socket and a Process alike. It holds what Node's HandleWrap object holds: its handle's address in the process's
 * memory (`handle_`, which libuv's callbacks name), its state (`state_`), its close callback
 * (`handle_onclose_symbol`), and the requests in flight its owner dispatched, which hold the loop whatever the
 * handle's ref, as libuv's do. `owner` is the binding object, whose callbacks (`target`) libuv's reach; `close`, `ref`,
 * `unref` and `hasRef` are the libuv calls of native/node's handle_wrap.c once the state allows them. What the
 * handle does is libuv's.
 *
 * The handle's memory is the binding's until the handle is initialized (MarkAsInitialized), and freed with its
 * object if it never is, as Node's uninitialized wrap goes when it is collected (BaseObject::OnGCCollect); once
 * initialized it is libuv's, and the C frees it after OnClose, as Node's OnClose drops its wrap.
 *
 * The run's end is still the engine's count (ADR-0018 item 2): an initialized handle is in it as libuv counts it
 * (`registerLibuvHandle`: active and referenced, closing, or with a request in flight), the count asking libuv each
 * time and keeping no copy of the rule.
 */
import { address, dispatchRequest, forgetHandle, forgetRequest, libnode, openHandle, type HandleCallbacks, type OpenHandle } from './libnode';
import { invokeOwned, ownedRun, ownerOfInstance, registerLibuvHandle, releaseLibuvHandle, type OwnedHandle } from './handles';

const kInitialized = 0, kClosing = 1, kClosed = 2;

/** The memory of a handle never initialized, freed once its wrap is collected; an initialized one is libuv's. */
const uninitialized = new FinalizationRegistry<{ at: number; libuvs: boolean }>(({ at, libuvs }) => {
  if (!libuvs) libnode().exports.tabnode_free(at);
});

export class HandleWrap implements OpenHandle {
  /** The handle's address in the process's memory (Node's `handle_`); 0 once closed, when the C has freed it. */
  wrap: number;
  #state = kClosed;
  /** The requests in flight under this handle, which hold the loop as libuv's do. */
  #inFlight = 0;
  #onclose: (() => void) | undefined;
  readonly #memory: { at: number; libuvs: boolean };

  /**
   * HandleWrap's constructor over the handle the binding's C made (`handle`, its address): initialized, or, as Node's
   * ProcessWrap and a TTYWrap whose uv_tty_init failed mark themselves, not until a call makes it so
   * (`markAsInitialized`).
   */
  constructor(readonly owner: OwnedHandle, readonly target: HandleCallbacks, handle: number, initialized: boolean) {
    const at = address(handle);
    if (at === 0) throw new RangeError('node: out of memory for a handle');
    this.wrap = at;
    this.#memory = { at, libuvs: false };
    uninitialized.register(this, this.#memory);
    if (initialized) this.markAsInitialized();
  }

  /** HandleWrap::MarkAsInitialized: libuv's handle from now, found by its callbacks and counted as libuv counts it. */
  markAsInitialized(): void {
    if (this.#memory.libuvs) return;
    this.#state = kInitialized;
    this.#memory.libuvs = true;
    openHandle(this.wrap, this);
    registerLibuvHandle(this.owner, () => this.holdsLoop(), () => this.hasRef());
  }

  /** HandleWrap::IsAlive: initialized or closing. */
  get alive(): boolean { return this.#state !== kClosed; }
  get closing(): boolean { return this.#state === kClosing; }

  /** What libuv counts of it: active and referenced, closing, or with a request in flight (uv__loop_alive). */
  holdsLoop(): boolean {
    if (!this.alive) return false;
    if (this.#state === kClosing || this.#inFlight > 0) return true;
    const { exports } = libnode();
    return exports.tabnode_handle_is_active(this.wrap) !== 0 && exports.tabnode_handle_has_ref(this.wrap) !== 0;
  }

  /** HandleWrap::Ref, Unref and HasRef (handle_wrap.cc:40-63). */
  ref(): void { if (this.alive) libnode().exports.tabnode_handle_ref(this.wrap); }
  unref(): void { if (this.alive) libnode().exports.tabnode_handle_unref(this.wrap); }
  hasRef(): boolean { return this.alive && libnode().exports.tabnode_handle_has_ref(this.wrap) !== 0; }

  /** HandleWrap::Close (handle_wrap.cc:72-86): once, from initialized; the callback is kept for OnClose. */
  close(callback?: unknown): void {
    if (this.#state !== kInitialized) return;
    libnode().exports.tabnode_handle_close(this.wrap);
    this.closingWith(callback);
  }

  /** The state a close leaves, with its callback (TCPWrap::Reset closes through its own call). */
  closingWith(callback: unknown): void {
    this.#state = kClosing;
    if (typeof callback === 'function') this.#onclose = callback as () => void;
  }

  /** uv_fileno: the descriptor, or a negative error where the handle has none. */
  fileno(): number { return this.alive ? libnode().exports.tabnode_handle_fileno(this.wrap) : -9; }

  /** A request dispatched under this handle: it holds the loop until it completes. */
  dispatch(complete: (status: number, ...rest: number[]) => void): number {
    this.#inFlight += 1;
    return dispatchRequest((status, ...rest) => { this.#inFlight -= 1; complete(status, ...rest); });
  }
  /** A dispatch that failed: its request will not complete. */
  undispatch(id: number): void { this.#inFlight -= 1; forgetRequest(id); }

  /**
   * HandleWrap::OnClose (handle_wrap.cc:135-157): closed; the owner's own close work (the wrap's OnClose), then the
   * close callback in its run where Close was given one. Answers whether it made the callback, whose scope the C
   * closes; the C frees the handle when this returns.
   */
  closed(): boolean {
    forgetHandle(this.wrap);
    this.#state = kClosed;
    this.wrap = 0;
    const callback = this.#onclose;
    this.#onclose = undefined;
    try { this.target.onUvClose?.(); }
    finally {
      releaseLibuvHandle(this.owner);
      if (callback) ownedRun(ownerOfInstance(this.owner), () => callback.call(this.owner), true, 'wrap', callback);
    }
    return callback !== undefined;
  }
}

/** MakeCallback on a request's `oncomplete`, in its run, as ReqWrap's callback is made. */
export function completeRequest(request: object, ...args: unknown[]): void {
  invokeOwned(request, 'oncomplete', ...args);
}
