/**
 * `internalBinding('timers')`, Node v24.21.0's src/timers.cc over its Environment (src/env.cc), for Node's own
 * `lib/timers.js` and `lib/internal/timers.js` (ADR-0018 item 2). The handles are the system's (system.ts
 * `SystemTimers`): on a kernel libuv's, in `node`'s C (native/node env.c), whose memory holds `immediateInfo` and
 * `timeoutInfo`; over no kernel the realm's. What is Node's C++ above the handles is here:
 * - RunTimers (env.cc:1552-1611) calls `processTimers` again after a throw, each throw reported as the process's
 *   uncaught exception (its TryCatchScope is verbose), until the call returns the next expiry;
 * - CheckImmediate (env.cc:1613-1636) makes each `processImmediate` call a callback (MakeCallback), whose throw is
 *   reported the same way; the handle's loop calls again while one is outstanding.
 * Each call is a callback scope of the loop's (withGuestCallback): its ticks run when it returns; on the program
 * RunTimers' scope closes in env.c after the timer is rescheduled (`close_scope`, then its drain), as Node's does. An exception goes to
 * the run whose context frame the throwing callback ran in, which Node's timers leave current where a callback throws
 * (lib/internal/timers.js sets the prior frame back only after a callback returns); where no run takes it, it is the
 * realm's, as it would end a Node process that has no handler.
 *
 * One Environment a realm: its timer lists (`internal/timers`) are the realm's, as the system's loop is (node-lib/load.ts
 * `REALM_ENVIRONMENT`).
 */
import { systemTimers } from '../../system';
import { withGuestCallback, withGuestExecution } from '../../guest-loop';
import { libnodeAttached } from './libnode';
import { reportUncaughtInFrame } from '../../shims/async_hooks';

function uncaught(error: unknown): void {
  if (!reportUncaughtInFrame(error)) throw error;
}

export function createTimersBinding(): Record<string, unknown> {
  const loop = systemTimers();
  return {
    immediateInfo: loop.immediateInfo,
    timeoutInfo: loop.timeoutInfo,
    getLibuvNow: (): number => loop.getLibuvNow(),
    scheduleTimer: (duration: number): void => loop.scheduleTimer(duration),
    toggleTimerRef: (ref: boolean): void => loop.toggleTimerRef(!!ref),
    toggleImmediateRef: (ref: boolean): void => loop.toggleImmediateRef(!!ref),
    setupTimers(processImmediate: () => void, processTimers: (now: number) => number): void {
      loop.setupTimers(
        () => withGuestCallback(() => {
          try { processImmediate(); } catch (error) { uncaught(error); }
        }, 'setImmediate', processImmediate),
        (now: number) => {
          const run = (): number => {
            for (;;) {
              try { return processTimers(now); } catch (error) { uncaught(error); }
            }
          };
          // On the program RunTimers' scope stays open past the call: env.c reschedules the timer, then closes it.
          return libnodeAttached() ? withGuestExecution(run, 'timer', processTimers) : withGuestCallback(run, 'timer', processTimers);
        },
      );
    },
  };
}

/**
 * `internalBinding('task_queue')` of a realm with no `node` program, as far as `internal/timers` reads it: V8's own
 * microtask queue. The realm whose process is `node` has Node's whole binding (task_queue.ts).
 */
const enqueue = globalThis.queueMicrotask.bind(globalThis);
export const taskQueueBinding = { enqueueMicrotask: (callback: () => void): void => enqueue(callback) };
