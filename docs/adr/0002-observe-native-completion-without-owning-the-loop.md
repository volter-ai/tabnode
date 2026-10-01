# Observe native completion without owning the loop

Status: accepted for bounded diagnosis; narrower closing-work correction is
recorded in ADR0003, with original F3 causality still unverified.

Card t_94bcd252, task t_8f8d833d; substrate Articles3,6,9 and the engine's
correction-toward-Node invariant.

The retained accepted-public F3 trace has a boot-owner result1 followed by
caller result0 after verified World rollback. It does not retain native IPC
and close callback order. Node's own internal/child_process.js unrefs its IPC
channel when a pending send completes. The binding releases the process
handle at onexit while native pipe close completion reaches the process on
another message turn. Libuv's documented loop-alive contract includes active
requests and closing handles, even when no referenced active handle remains
([loop API](https://docs.libuv.org/en/stable/loop.html#c.uv_loop_alive)); Node's
child close event follows process exit and descriptor completion
([Node22 API](https://nodejs.org/docs/latest-v22.x/api/child_process.html#event-close)).
This is a candidate explanation, not a measured F3 cause.

Use an explicit `NODE_DEBUG=tabnode-completion` selection on the diagnostic
command. The native binding and common Node runner record only timestamps,
process/descriptor numbers, exit codes, handle/work counts and boolean state.
They record no argv, paths, env values, guest messages or byte contents. Each
realm emits at most4096 records. The observer adds no ref, request or timer;
its sink failure cannot change a result. With the selection absent, descriptor
close has its existing callback behavior.

Verify the selection against the consumer's served worker bytes before reading
the trace. Installing a source tarball does not rebuild a consumer's prebuilt
shell. An absent marker in that shell is not evidence of an absent callback.
The consumer may select the diagnostic through its public environment option;
the unmodified guest and World still own their ordinary result and policy.

The current-source captures under substrate task evidence
`f3-diagnostic/completion-rebuilt`, `completion-cold` and
`completion-verified-cold` retain successful close/return sequences and one
ordinary startup failure correctly propagated as caller exit1. The verified
cold capture records zero filesystem, IndexedDB and cache usage before boot.
These observations do not reproduce the accepted-public lost failure, so they
do not establish the original lost-failure cause. Diagnostic selection
and machine contention also exclude them from canonical latency accounting.

The event order must show whether the caller returned with an unreferenced IPC
channel before EOF/close delivery, or locate a different failure. A correction
must preserve Node's child exit/close ordering and ordinary unref behavior,
retain real native completion rather than add a delay, and remain independent
of the app, framework, service and vendor. The owner forbids automated tests;
the authorized F3 product diagnosis and subsequent independent review own the
observations. These observations do not establish a performance floor.

ADR0003 separately corrects the source/trace-proven zero-count interval for
pending inherited-descriptor close. That contract violation is established by
successful traces; the original lost-failure causal claim remains unqualified.
