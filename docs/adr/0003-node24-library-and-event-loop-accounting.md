# ADR-0003: Node 24 library and measured event-loop utilization

Status: Accepted

Date: 2026-10-05. Orchestrator unit8a, approved assessment and steps1–2;
engine invariants: Node at source, unchanged packages, done in the tab.

The library is Node22.18.0 while the default guest identity is22.12.0.
The approved first migration checkpoint is the unchanged Node24.5.0
library, the minimum version the pinned Twenty manifest requires. Its
existing vendor paths move together with their binding contracts and loader
initializers. A version string alone is not an upgrade. DNS0.5.64 and
process-group identity/signals remain part of the contract. The subsequent
current-LTS24.21.0 work remains separate from this checkpoint.

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
