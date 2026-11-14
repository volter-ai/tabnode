// The engine's imports (Tabnode ADR-0018 §2): what libnode's C calls in the realm's JavaScript, as Node's C++ calls
// into V8. One module, `host:tabnode`, the identity the substrate registers the engine under (its `hostPrograms`); the
// machine answers it from the engine module's `imports` (browser-substrate host/task.mjs).
#ifndef TABNODE_ENGINE_H
#define TABNODE_ENGINE_H
#include <stdint.h>

#define TABNODE_IMPORT(name) __attribute__((import_module("host:tabnode"), import_name(#name)))

// Runs Node's library over the bindings (Node's `node::LoadEnvironment`): answers 0, or the status to exit with.
TABNODE_IMPORT(bootstrap) int tabnode_bootstrap(int argc, char **argv);
// `timers_callback_function` (lib/internal/timers.js `processTimers`), called with the loop's now: the next expiry, 0
// for none, negative where no timer left holds the loop.
TABNODE_IMPORT(process_timers) double tabnode_process_timers(double now);
// `immediate_callback_function` (lib/internal/timers.js `processImmediate`).
TABNODE_IMPORT(process_immediate) void tabnode_process_immediate(void);
// `process.emit('beforeExit')` (Node's EmitProcessBeforeExit): answers 0, or nonzero where the process is stopping.
TABNODE_IMPORT(before_exit) int tabnode_before_exit(void);
// `process.emit('exit')` and the exit code (Node's EmitProcessExitInternal).
TABNODE_IMPORT(exit) int tabnode_exit(void);
// The close of a callback's scope (Node's InternalCallbackScope::Close, src/api/callback.cc): the tick queue, then the
// microtasks, which a browser runs only between tasks, so the engine answers it by a suspension that resumes from the
// next task (a `Suspending` import).
TABNODE_IMPORT(drain) void tabnode_drain(void);
#endif
