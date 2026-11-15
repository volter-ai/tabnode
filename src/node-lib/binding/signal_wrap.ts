/**
 * `internalBinding('signal_wrap')` (ADR-0018 §3, item 8): Node v24.21.0's src/signal_wrap.cc over the program's
 * uv_signal_t. A `Signal` is a HandleWrap (`handle_wrap.ts`) over native/node's uv_signal_t (signal_wrap.c),
 * initialized when it is made, as SignalWrap's constructor CHECKs uv_signal_init; `start` is uv_signal_start, `stop`
 * uv_signal_stop, and libuv's callback calls `onsignal` with the signal's number (the program's `signal_received`
 * import), after which the C closes the callback's scope. Node's own `lib/internal/process/signal.js` makes one for
 * each signal the process listens to (startListeningIfSignal), so a signal reaches a listener the way libuv delivers
 * it: its one handler for the signal, the loop's signal pipe, every uv_signal_t on it. What a signal does is libuv's
 * and the kernel's.
 *
 * Where it is not Node's: SignalWrap keeps a count of the started wraps of each signal (`handled_signals`), whose one
 * reader is `process._kill` (node_process_methods.cc:199-205, `HasSignalJSHandler`, deciding whether a kill of the
 * process itself runs its at-exit hooks); `process.kill` is still the engine's (src/shims/process.ts), so nothing
 * reads one, and it is not kept. SIGPROF's refusal while the inspector listens is the inspector's, which a tab does
 * not have.
 */
import { libnode, type HandleCallbacks } from './libnode';
import { HandleWrap } from './handle_wrap';
import { invokeOwned, type OwnedHandle } from './handles';
import { nextHandleAsyncId } from './stream_wrap';

export class Signal implements OwnedHandle, HandleCallbacks {
  declare onsignal: ((signum: number) => void) | null;
  readonly #handle: HandleWrap;
  readonly #asyncId = nextHandleAsyncId();

  /** SignalWrap's constructor (signal_wrap.cc:88-95): its uv_signal_t, initialized. */
  constructor() {
    this.#handle = new HandleWrap(this, this, libnode().exports.tabnode_signal_new(), true);
  }

  getAsyncId(): number { return this.#asyncId; }
  // HandleWrap's close, ref, unref and hasRef (src/handle_wrap.cc).
  close(callback?: () => void): void { this.#handle.close(callback); }
  ref(): void { this.#handle.ref(); }
  unref(): void { this.#handle.unref(); }
  hasRef(): boolean { return this.#handle.hasRef(); }

  /**
   * SignalWrap::Start (signal_wrap.cc:105-141): the signal as V8's Int32Value takes it, then uv_signal_start; libuv's
   * answer. Nothing for a wrap whose handle is gone (ASSIGN_OR_RETURN_UNWRAP of a closed wrap).
   */
  start(signum: unknown): number | undefined {
    const handle = this.#handle;
    if (handle.wrap === 0) return undefined;
    return libnode().exports.tabnode_signal_start(handle.wrap, +(signum as number) | 0);
  }

  /** SignalWrap::Stop (signal_wrap.cc:143-154): uv_signal_stop; libuv's answer. */
  stop(): number | undefined {
    const handle = this.#handle;
    if (handle.wrap === 0) return undefined;
    return libnode().exports.tabnode_signal_stop(handle.wrap);
  }

  /** Start's callback (signal_wrap.cc:121-130), the program's `signal_received`: `onsignal` made as MakeCallback makes it. */
  onUvSignal(signum: number): void {
    invokeOwned(this, 'onsignal', signum);
  }
}

export default { Signal };
