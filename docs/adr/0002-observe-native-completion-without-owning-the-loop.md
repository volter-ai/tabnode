# Observe native completion without owning the loop

Status: accepted for diagnosis; no lifetime correction established.

Card t_94bcd252, task t_8f8d833d; substrate Articles3,6,9 and the engine's
correction-toward-Node invariant.

The retained accepted-public F3 trace has a boot-owner result1 followed by
caller result0 after verified World rollback. It does not retain native IPC
and close callback order. Node's own internal/child_process.js unrefs its IPC
channel when a pending send completes. The binding releases the process
handle at onexit while native pipe close completion reaches the process on
another message turn. This is a candidate explanation, not a measured cause.

Use an explicit `NODE_DEBUG=tabnode-completion` selection on the diagnostic
command. The native binding and common Node runner record only timestamps,
process/descriptor numbers, exit codes, handle/work counts and boolean state.
They record no argv, paths, env values, guest messages or byte contents. Each
realm emits at most4096 records. The observer adds no ref, request or timer;
its sink failure cannot change a result. With the selection absent, descriptor
close has its existing callback behavior.

The event order must show whether the caller returned with an unreferenced IPC
channel before EOF/close delivery, or locate a different failure. A correction
must preserve Node's child exit/close ordering and ordinary unref behavior,
retain real native completion rather than add a delay, and remain independent
of the app, framework, service and vendor. The owner forbids automated tests;
the authorized F3 product diagnosis and subsequent independent review own the
observations. These observations do not establish a performance floor.
