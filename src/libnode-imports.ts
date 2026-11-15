/**
 * THE ENGINE'S IMPORTS THE BINDINGS ANSWER (ADR-0018 §3, native/node engine.h): libuv's callbacks into a binding's
 * JavaScript, as Node's C++ makes them with MakeCallback. The host that runs `node` puts these among the program's
 * `host:tabnode` imports beside its own; each C caller closes the callback's scope (`drain`) after it returns.
 */
import { HandleWrap } from './node-lib/binding/handle_wrap';
import { processExit } from './node-lib/binding/process_wrap';

export const libnodeImports = {
  /** HandleWrap::OnClose: 1 where it made the close callback, whose scope the C closes. */
  handle_closed: (handle: number): number => (HandleWrap.closed(handle) ? 1 : 0),
  /** ProcessWrap::OnExit: the handle's `onexit`. */
  process_exit: processExit,
};
