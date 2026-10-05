# ADR-0003: Node 24 library and measured event-loop utilization

Status: Accepted

Date: 2026-10-05. Orchestrator unit8a, approved assessment and steps1–2;
engine invariants: Node at source, unchanged packages, done in the tab.

The engine now carries unchanged Node24.5.0 library files with the
matching default guest identity. The first migration checkpoint is the unchanged Node24.5.0
library, the minimum version the pinned Twenty manifest requires. Its
existing vendor paths move together with their binding contracts and loader
initializers. A version string alone is not an upgrade. DNS0.5.64 and
process-group identity/signals remain part of the contract. The subsequent
current-LTS24.21.0 work carries the same invariants. Move primordials and
Buffer's public/internal pair together, adapting explicit buffer arguments,
allocation and non-transferable pool ownership at the native binding. Carry
util/errors/validators and timer/async-context contracts before completing
the unchanged filesystem/stream and socket/process closure. New internal
modules must resolve their actual engine binding; an empty native object
cannot substitute for a required contract. Library/guest identity moves to
24.21.0 only with that coherent closure. Keep DNS, detached groups and
MessagePort ref/unref and delivery. Preserve process-owned contexts, file
handles and existing World routing. Native operations without a browser
capability retain an exact named failure, never a fabricated result.

This current-LTS milestone is qualified by the actual prepared page and
released registry artifact. Twenty's unchanged production server must then
serve its own /healthz200 through the declared World infrastructure and
complete supported teardown. That application reading is distinct from
library compatibility and from authentication/worker/native profiling
qualification. No library copy or version override establishes startup.

Node's perf_hooks exposes GC-kind constants and eventLoopUtilization.
The engine currently exposes neither the constants nor utilization; a
program reading those at import or provider construction fails before
listening. The constants are Node's native enum values. Utilization uses
actual monotonic execution intervals at the engine's module, continuation
and callback dispatch boundaries, including EventEmitter, AsyncResource
and both native and host-owned MessagePort delivery. Nested execution counts once. Time
waiting for a timer, promise or host I/O is idle, not active merely because
work is pending. Snapshots include work currently executing, and one- and
two-snapshot deltas follow Node's subtraction behavior.

This measures the guest execution loop in its worker realm, which multiple
virtual processes in that realm share. It is not OS CPU accounting or a
claim about the browser's GC/native host work outside those boundaries.
No GC events or heap numbers are fabricated. The existing browser observer's
lack of native GC events remains named. Importing the engine installs no
clock task, observer or handle; accounting starts when a runtime exists and
uses its existing dispatch paths rather than a sampling timer.

An unqualified native addon is optional until its export is loaded. The
substrate's authenticated exact binding/refusal maps own qualification.
A load with no prepared binding reports the filename and the preparation
door and fails; it does not become a successful empty module. Packages run
unchanged and may handle that failure using their own code. An eager
uncaught import still fails the program. There is no package-name exemption,
profiler stub, forced platform/ABI or application edit to hide the failure.

The assigned reading measures idle wait and synchronous busy work through
perf_hooks in the page, the snapshot/delta forms, actual optional-addon
load refusal, preserved DNS and detached process-group behavior, and the
prepared real production entrypoint. Any Twenty native import refusal is a
named remaining capability, never a successful server-start claim. No
release is cut until the required page reading succeeds. The catalog worker
receives the released engine version and exact ABI and owns the coordinated
substrate pin/catalog publication.

References: Node24.5.0 lib/internal/perf/event_loop_utilization.js,
src/node_perf.h and the approved external node24-plan.md; substrate
ADR-0094 Optional capability availability. No Node suite, standalone
check, typecheck, lint or review runs while building this unit.

Current-LTS native boundaries: advanced child IPC now calls ipc_serdes. The
browser has no V8 binary wire codec; serialize/deserialize throw
ERR_UNSUPPORTED_OPERATION with capability ipc.v8-serialization on use,
while default JSON IPC retains its upstream protocol. Native key comparison
likewise refuses synchronously rather than inventing key identity/bytes.
TCP type-of-service returns UV_ENOTSUP because virtual streams have no IP
packet headers. Keepalive accepts the new interval/count arguments but
virtual in-realm/owner pairings still have no TCP probe packets; it does not
configure OS idle probes. TTY enum values follow libuv; ADR-0023's actual
terminal mode refusal remains. No Windows HANDLE can be imported on the
engine's Linux platform.

Diagnostics native links and subscriber counts belong to each process's
builtin graph. Only actual engine-origin publications use those links; no
GC or CPU events are manufactured. Assertions obtain their position from
captured native call sites and the actual transformed script compiled by
the engine. Positions describe that script; source-map remapping is not
enabled. Missing compiled-source/native-frame information is the named
errors.source-position capability failure, not an invented empty location.
AsyncLocalStorage defaultValue/name/exit/withScope operate on real context
frames. Internal timers own real native callbacks, release handles when
fired/cancelled, and restore captured context. Unsafe Buffer allocations are
zeroed browser ArrayBuffers; the detach key prevents transfers through the
engine's MessagePort, Worker and structuredClone doors, not arbitrary host
code that bypasses these doors. The amaro dependency matches Node24.21's
actual 1.1.11 release; compiler assets selected by a prepared image remain
separately qualified by the substrate.
