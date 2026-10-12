## S2 initialization boundary evidence

Status: bounded instrumentation coded; initialization attribution pending

Articles 5/6/8/9: retained Dub request-event to head is499–516ms, but native first-require to first-answer416–417ms includes startup. Native listen to head230ms and the tab's first quiet clock includes the later1525-body preload, so those cumulative captures cannot identify the excess initialization phase. Extend the existing deferred load-clock evidence at the first positive read of each of the first3 accepted TCP sockets per listener and at the already sampled first3 vector submissions/completions. Resolve the process through the handle's actual run owner, retain every existing field, and add stream correlation and a shared performance timestamp. Positive native read is a transport boundary, not an HTTP request event. Preserve quiet/exit de-duplication, defer byte materialization through R5, and add no handles, timers, guest hooks or scheduling changes. No initialization cause or saving claimed before an independent matched capture; production emission only.

## S2 unused response client removal

Status: source cleanup intended; independent response reading pending

Articles 5/6/8/9: all five retained server entries already use the native stream holder and its existing loopback client/parser. Remove65fc5ef's redundant requestServer method/import and52c07d47's unused adapter in normal follow-ups after the instrument-only push. Preserve generic writev gathering and bounded observer fields. No cause or saving is claimed for the4.8s after write-head; current instruments must identify actual vector submission/receipt/completion. The policy-confined native-stream omission has no named reached image and stays a recorded gap, with no behavior addition. Production emission only.

## S2 bounded native write evidence

Status: instrumentation intended; no delay cause claimed

Articles 5/6/8/9: retained Dub head-to-answer4.8s is unclassified. Full launch sequences show Rallly/Twenty/Cal/Dub use runNodeOnItsTree→the store-owner Node process bridge, while LibreChat's server is a further Node child through the descendant bridge. Both already supply native streams; private entry filenames are not a route discriminator. The existing holder loopback client means the earlier client relocation account was incorrect, and65fc5ef gathering is compiled but has no measured attribution. Add nativeStreams/nodeProcessMode to the existing host-init mark, then bounded accepted-TCP write-vector and chunk submission/owner-receipt/owner-completion/client-completion records. Correlate scope-local listener/handle/vector/chunk/request, with shared timestamps, byte counts and bounded iovec lengths; no bytes, ports, caller authority or behavior changes. First3 vectors per listener and first3 chunks per vector are sampled; completion summaries retain full counts. The next independent Dub capture must identify whether its307 is split and when the bytes actually leave before naming a cause. Remove the unused API/adapter as a later ordinary commit. The policy-confined stream omission is a known gap, with no named reached image; do not build it here. Production emitting compilation only, no tests/apps/timings.

## S1 crypto curve enumeration integration

Status: source port coded; independent runtime qualification pending

Restore Node's supported elliptic-curve enumeration at the existing native crypto seam (substrate Articles 5/6/9). The pinned Seerr stop names getCurves; engine afd222b still exports its platform-unavailable function, although its genuine EC registry carries P-256/P-384/P-521. Published preload commit 14126b0 is already an ancestor; curve repair 39754de, merged as c7a42fca, is not. Port only that registry-derived enumeration and its export accounting onto the current engine line. A getCurves implementation already present in afd222b, or a returned name absent from the real binding registry, would disprove this diagnosis. Production compilation is builder evidence; the independent sweep must prepare/rebind the integrated engine and observe the original pinned Seerr start. No tests, probes, applications or timing runs in this unit.

C6 attribution (substrate Articles5/6/8/9; ADR0124): an entry body started through _load evaluates at require depth0. Its first child require returns to depth0 and currently forces outside even while its caller is still evaluating. Restore the saved phase instead; require depth continues to control only stat caching. The emitted kernel split omits blocking accumulated in the currently open phase; capture its delta without changing the live counter. Substrate runtime-file union and confinement wrappers independently need to forward kernelBlockedMs. Native whole-run floors do not separate the same bodies yet; new native capture is the substrate operator unit. Compiler evidence only; corrected phase attribution and app-time gap remain the mini reading.
## S1-npm-version: Report the image's npm identity

Status: built; independent image qualification pending

Substrate Articles 5/6/8/9: MeshCentral's retained start calls npm -v, while
this engine's npm command rejects both version flags as unknown commands. No
upstream npm package is bundled in the engine. For version-only queries,
read the calling tree's npm package.json, resolving the CLI and manifest
through that tree's realpath. A held npm CLI identifies its own nearest npm
manifest and bin entry. Catalog markers replace PATH aliases, so their
metadata belongs to the actual global npm installation under the image's
PATH prefixes; verify its declared npm bin exists and resolves within that
package. Require one unambiguous installation, a manifest named npm and a
valid version. Do not use the app's version, registry requirements, host npm,
engine package version, or a constant. Missing/malformed/ambiguous metadata
returns an explicit nonzero refusal. Keep install behavior and traps intact.

Disproof: a query prints a version with no matching held npm manifest/bin,
borrows another tree, ignores a conflicting installation, or invents a value.
Builder receipt: full Vite library bundle0 and full declaration compiler0,
sequentially within nine seconds each. Normal hooks/push retain the source.
No tests, apps or runtime queries ran here. Images whose catalog placement
stripped the original npm package still refuse; ADR-0130 row11 remains intact.
No npm distribution is bundled in this engine.
C6 attribution/body observer cost (substrate Articles 5/6/8/9; ADR0124): caller phases and open kernel blocking are now corrected; native same-body pairing remains with the next lap. Retained Dub link UTF8 counting103ms serves only load-clock byte totals, never a byte budget. Capture immutable references/prefix limits and materialize bytes in the producing realm after HTTP, with terminal fallback and scalar-only evidence transport; no source copies cross a port. Compiled source retention37ms serves Node errors.getErrorSourcePositions, but scanned the whole wrapped script for a known sourceURL. Retain source under the normalized name already generated by both load and entry paths, including async/generator retries. Preserve actual error coordinates, latest source per name and per-process release. Counts, snapshot totals and application behavior require runtime reading; no app-time gain claimed by compilation.

R5 host-owned evidence: the engine sends stable boot/socket/stream fields to the host trace seam, using portable formatting instructions for mutable counter summaries. Source-dependent byte totals remain local until capture. Ordinary program output and execution APIs retain their behavior. The R5/K5 follow-up removes the remaining diagnostic insertion from Node's file; app-time and delivery qualification remain with the independent lane. No tests, probes or app measurements in this builder.
Child process credentials: restore Node/libuv spawn uid/gid for asynchronous and synchronous children, including kernel-backed admission. Parent records are private; numeric declarations are checked, and a root parent clears supplementary groups before its declared child identity. Existing inheritance and default 1000 remain. Runtime qualification pending.

# tabnode roadmap (Volter's fork)

Open work on tabnode, Volter's fork of `macaly/almostnode`, Node in the browser patched toward Node as source. One
`## <id>: <title>` section each, with `Status:` and the `Completion:` lines that define done. The
measure is Node's own suites run against `dist/index.mjs` by `scripts/node-tests.mjs`
(`scripts/NODE-TESTS.md`); `BUILTINS.md` carries each module's number and what each remainder
is made of. The consumer is `volter-ai/browser-substrate`, which pins the engine by version and whose
changelog records what each version changed in the tab. What shipped is in
[`CHANGELOG.md`](CHANGELOG.md), one section per release; the fork's rules are
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`RELEASING.md`](RELEASING.md).

## preparation-heap: Release syntax trees before assembling bodies

Status: built and compiled; original-image preparation qualification pending

Substrate Articles 1/2/6/8/9; ADR-0051/0092. code-server owner3216 at
substrate dc6d37c0 / engine eeab9cb7 aborts in named-file modules job3 with
SIGABRT and V8 heap exhaustion at the unchanged1024 MiB limit. Its preceding
jobs0/1/2 completed113/229/877 named files; job3 has no archives. The owned
request and asset were removed, so the exact failed file/pass is unknown.
No archive-expansion, application-runtime or deadline cause is established.

The source still assembles ESM declaration replacements by repeated whole-
module slice/concatenate, unlike the other linear edit assemblers. Each
replacement copies surrounding source again. Runtime's outer ESM AST also
remains referenced while the nested declaration/live-import lowerer parses
its modified source. Other passes retain their AST during output assembly.
These are concrete unnecessary allocations independent of which asset failed.

Collect the existing exact edits first, release each syntax-tree reference
before assembly/any nested parser, and assemble the final ESM declaration
edits with the shared linear span assembler. Preserve stable edit order,
source-coordinate semicolons, hoisted exports and every existing fallback.
Syntax recognition, live bindings, await/global/dynamic-import rewrites and
prepared format/output identity remain unchanged. The companion host derives
keys from its already computed native SHA-256 instead of encoding/hashing the
same source again; its own trace retains largest sources and memory snapshots.
No new process/heap/batch/deadline limit, skip or retry is introduced.

Disproof: changed body bytes/keys, a syntax tree held across nested lowering,
repeated full-source assembly, or continued abort in the original image.
Completion: full library/declarations compile and normal source push; the
independent original-image build qualifies actual heap behavior. No test,
application preparation or timing runs on this builder.

Builder evidence: full Vite library bundle and TypeScript declaration compiler
passed (0/0), sequentially inside nine seconds per invocation. The generated
bundle retains all six explicit AST releases and the single declaration span
assembly. This is compiler-artifact inspection, not runtime/body qualification.

## S2-D3: End a proven empty Node loop without polling

Status: built and compiled; independent N2 floors reading pending

Articles 5/6/8/9: the mini's retained floors-875352ef/n2-dry1.log, engine a9cc8bf, records
`node -e 0` returning its entry at 1791789718376 and draining 7116 ms later. The only counted
hold is the idle rule: forty looks account for 2000 ms, with no wake after the first empty
look about 199 ms after entry. The 485 wait-state messages are a page coordinator aggregate,
not a guest work holder. The engine schedules each look with its realm's browser timer and
adds a synthetic 50 ms, so delayed callbacks extend the forty-callback silent rule. The log
does not distinguish timer task delay from other scheduling between looks; do not invent a
specific browser throttle or attribute those messages to the Node guest's loop.

After entry settlement, a named run's registered loop can establish no referenced timers,
ports, handles, pending native I/O, held child/build/native host work or consumed open stdin.
Recheck that state after the existing native task/rejection checkpoint, then emit beforeExit
in its run and retain work that its listeners schedule. End immediately if it remains empty,
without a 50 ms look or the silent idle counter. Caller-held runs retain their owner's
lifetime; unregistered runs retain the existing uncertainty rules and 60 s bound. Use the
existing native filesystem task channel for the checkpoint instead of a browser timer.
Keep D1 fields; add actual timer-wait/body/checkpoint intervals and realm identity to its
drain record, so a remaining counted-work delay is located by the next retained reading.

Completion: bundle/declarations compile, normal hooks and push, and the independent floors
job reads N2 on its next lap. No new runs, tests, probes or timings in the builder lane.

Builder evidence: final `npm run build:lib` passed (Vite library bundle and TypeScript
declarations). No substrate source change is required. The retained record does not identify
the browser scheduling mechanism responsible for the extra timer wait; the new trace separates
actual timer waits, synchronous look work and native checkpoints. Active references still use
the existing wait loop; a newly observed empty named loop reaches the checkpoint before any
further timer look. Runtime gain and lifecycle behavior remain the floors lane's reading.

## D2: End a printed program at its first empty look

Status: built and compiled; independent five-app qualification pending

Substrate Articles 1/5/6/8/9; engine invariant: correct toward Node at source.
D1 bf43898 records whether work returns after a look with neither new output
nor pending guest input, timers, ports, handles or held child/build work.
The retained review logs contain 57 run-drained readings: Rallly40, Twenty12,
Dub4 and Cal1; all have empty wokeAfterEmpty. No retained LibreChat reading
is available. The coordinator explicitly assigns phase-1 implementation now;
LibreChat and the other four remain the independent cycle's behavioral gate.
No five-app measurement or gain is claimed by the builder.

After a printed program's entry settles, end at the first existing 50 ms
look with no new output and none of the counted work. Remove the redundant
500 ms wait and its 100 ms child-exit variant. A look that sees new output
is not empty. Silent programs retain the existing 2000 ms idle rule; the
60000 ms bound, caller-held runs, aborts, exits and entry settlement stay
unchanged. Input, timers, sockets/ports and held work retain the program.
Keep all D1 trace field names and emit the drain record for a short empty
look too, so the next cycle still sees its decision. Remove the obsolete
child-exit idle-shortening observer; child ownership/reaping remain intact.

Disproof: a program with counted work ends, a silent run loses its 2 s rule,
a caller-held run drains itself, or an unchanged app's walk breaks on D2.
Completion: library bundle and declarations compile, ordinary commit/push,
and the independent cycle qualifies all five. No apps, tests or timing here.

Builder evidence: the full Vite library bundle and TypeScript declaration
compiler completed successfully (0/0), sequentially within nine seconds each.
The D1 evidence above is retained log reading, not a new run.
## process-load-env-file: Load a process environment file

Status: built; independent runtime qualification pending

Substrate Articles 6/8/9 (ADR-0007/0021): Reactive Resume's retained dc6d37c0 start stops at
`process.loadEnvFile is not a function` in its unchanged server entry. `createProcess` does not
provide the method, although the native util binding already parses environment files. Restore
Node's synchronous default `.env` read, validated string/byte/file-URL paths, existing-key
precedence and missing-file error through the calling process's native filesystem and parser.
Use its existing builtin scope, including child and worker processes; do not change the app,
vendor library files or interpreter options. A present method followed by a different stop
would disprove this missing-method diagnosis for that later start.

Completion:
- Library bundle and declarations compile; normal hooks and push retain the source correction.
- The independent image lane qualifies the unchanged start. No app, test or probe runs here.

Builder evidence: the final `npm run build:lib` passed (Vite bundle and TypeScript declarations).
The source implementation uses the calling process's tree/cwd and native fs/util bindings.
Existing parser parity and unchanged-image behavior remain unqualified; no tests or probes ran.

## R4: Identify socket completion and timeout cancellation

Status: instrument built; historical Redis timeout cause unresolved

Substrate Articles 3/5/6/8/9: Twenty's retained gate-10 and d670 runs report node-redis 4.7.0's
ConnectionTimeoutError from socket.js:177. Its unchanged @redis/client 1.6.0 clears the socket timeout in its
connect listener. The newer 008d1bf4 runs have only World-up PID 2 socket-connect readings: the app exits on a
separately owned permissions defect before opening its sockets. The existing client-dispatched trace says a
transport listener returned, but does not establish that the TCP request callback ran or that the socket's
timeout was cancelled. Extend that same trace at the engine's binding callback, recording descriptor/request
identity, guest PID, socket connecting/destroyed state, connect listener count and the existing timeout's
destroyed state before and after Node's own callback. Trace timeout firing with the same socket identity.
Keep vendored Node files, connection behavior, timers, deadlines and callback ownership unchanged. Do not
attribute the later d670 storage-lock failures to this timeout without matching evidence.

Completion:
- Library and declarations compile, ordinary hooks stay on, and the source branch is pushed normally.
- The existing Twenty cycle after its permissions repair supplies application socket completion and timer
  readings. A delivered callback that cancels the timer disproves missing connect as that socket's cause.
- The actual general defect is corrected from that evidence and Twenty's cycle walk reaches 13/13. An
  instrument commit alone does not complete this row. This builder runs no app, test or timing.

Builder evidence: the Vite library bundle and TypeScript declarations compile. No test, application or timing ran.
The next application trace remains required; the 008d1bf4 PID 2 probes establish only World readiness.

## process-credentials: Report and inherit configured process credentials

Status: built; kernel integration and runtime qualification pending

ADR-0129's configured uid/gid/supplementary groups are per process, inherited at fork and retained by the host at exec, with no setuid support. The permission family's retained NetAlertX run has image USER 0 but a guest identity of 1000; kernel ownership/permission work belongs to that family. The engine currently reports fixed 1000 through the shared OS shim and has no credential option or launch field. Add `credentials: { uid, gid, groups }` to Runtime/IRuntime, container runs and trusted Node launches. Copy and validate unsigned numeric ids, retain an immutable process-owned record, and return fresh group arrays with the effective gid included as Node does. Real/effective ids are equal because this engine has no setuid. Default uid/gid and groups stay 1000/[1000]. Bind Node's native OS and spawn answers to their actual NodeLibScope process, including an unnamed Runtime, rather than ambient globals or mutable guest getter methods. Carry the record through local/host child launches, shell runs, synchronous children and WorkerRuntime initialization. The host/kernel supplies retained credentials when creating a realm after exec; image USER resolution and permission enforcement stay in the substrate. Disproof: a concurrent sibling's credentials, input/returned-array mutation, or a child reverting to default identity. Compile the library/declarations, commit with ordinary hooks and push; no app/test/probe/measurement runs in this lane.

Builder evidence: `npm run build:lib` passed on the final source (Vite bundle plus declarations). An earlier declaration compile caught a missing held flag in the temporary configured shell-run record; it was corrected. OS/process/spawn changes are in engine-owned TypeScript bindings, with vendored Node JavaScript unchanged. WorkerRuntime copies credentials to its worker, and the external Node worker-thread host receives the record as module’s fourth argument for its Runtime admission. Original-image USER resolution, retaining the kernel record at exec, consumer process/thread admission wiring and observed permission/identity behavior remain with the permissions family. No tests, probes, apps or timings ran.

## K5: Deliver asynchronous filesystem completions from the event loop

Status: built; independent runtime qualification pending

Substrate Articles 5/6/8: an asynchronous filesystem request completes from Node's loop, never from its next-tick
or promise queue. The native fs binding currently sends both callback and promise work through nextTick or
queueMicrotask. An application initializing its server through a chain of asynchronous fs calls can consequently
enter synchronous preload work before the worker handles its queued incoming request. In the retained Dub
production run c031fb53 / engine eeab9cb / World 3.0.2183 (mini, carried reuse build, scored dry-run2), the probe
starts at shared epoch 1791758780688.2449 and the first guest request event arrives at 1791758789347.8, after 1521
module bodies; the 307 head follows at 1791758789457.1. This establishes pre-dispatch delay, not its complete cause.
Next 15.5.8's unchanged startup awaits filesystem operations before handlersReady; the same native binding defect
is present in engine 14126b0, this change's base.

Queue each asynchronous fs operation as a host MessagePort task, retaining the captured filesystem, cwd and owner.
Keep one private, lazily created channel per realm; native host ports are referenced only while work is pending.
Each pending operation also holds its guest run and is cancelled when that run ends. Deliver the existing callback
in its owner's MakeCallback scope and resolve or reject the existing promise in its owner's scope. Synchronous fs
calls and guest nextTick/promise scheduling keep their behavior. Do not reorder a framework's preload or interrupt
its synchronous work. Node's loop contract owns the correction:
https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick

Completion:
- Source bundle emission passes, ordinary hooks remain enabled, and the source branch is pushed normally.
- The mini's unchanged Dub image establishes request dispatch before preload completes, first document behavior
  and the app-time effect. A request that already arrived before preload in the failing arm disproves the proposed
  connection between the native binding defect and K5. This builder runs no app, test or timing.

Builder evidence: Bun emitted the fs binding and native task helper for the browser (93 modules), with package
dependencies and unchanged Vite raw-source assets external. This is targeted source bundle emission, not the full
Vite library/declaration build or a typecheck. Its existing availableParallelism export warning is unrelated to the
changed paths. No tests or measurements ran.

## node-import-preloads: Settle --import before the entry

Status: built; independent runtime qualification pending

Node loads all --require preloads before --import preloads and awaits imports, including their top-level awaits, before evaluating an entry or -e. The engine currently parses these options but executes neither in its Node command. Add a process-runtime preload method using the same working-directory require, dynamic import and module cache as the entry, and read preloads from NODE_OPTIONS before command-line options. Preserve the original execArgv for fork inheritance. Await imports through the existing process-exit/error path before admitting the entry; no package or provider is recognized. The substrate's native-binding bootstrap separately awaits explicitly declared provider initializers and uses awaited imports for its generated preloads.

Completion:
- The library and declarations compile, ordinary hooks remain enabled, and the branch is pushed normally.
- Runtime behavior and original-image qualification stay with the independent sweep lane; no app or test runs here.

Builder evidence: `npm run build:lib` passed, including the Vite bundle and declaration compiler. No tests, probes, app starts or measurements ran.

## C6: Name the load-clock process and distinguish body sources

Status: built; independent metrics observation pending

The native/module-path comparison needs the entry script and the origin of every body counted by the tab's
existing `load-clock` line. Add `script`, the POSIX basename of this process's `argv[1]` (null when absent), and
`preparedBodies`/`preparedBodyBytes` and `sourceBodies`/`sourceBodyBytes` on that same line. Count at the existing
body handoff: a body read from the prepared directory, by digest or source hash, is prepared; a body transformed
from source in this process is source, including one newly kept in the prepared directory. Each new byte counter
is the UTF-8 size of the body handed to the compiler, before its wrapper. Existing fields and their accounting
remain unchanged. Startup streams populate the filesystem in the embedder; the engine has no separate stream
body handoff, so those reads use the same prepared/source paths. This is a general instrument for comparing
Node's module loading, with no package recognition or execution change.

Completion:
- The library bundle and declarations compile, and the change is committed with hooks enabled and pushed.
- Runtime counts and the native comparison remain for the independent metrics cycle; no measurement runs here.

Builder evidence: the `build:lib` Vite bundle step passed; the combined command reached the owner's ten-second
script cap during declaration generation, then its exact `tsc -p tsconfig.build.json` step passed separately.
There is no installed Git commit hook in this checkout; the commit uses ordinary hook-enabled Git.

## C6-module-allocation: Count body bytes without materializing them

Status: built; independent app-time qualification required

Serves substrate Articles 1/6/8: loading the same prepared bodies must not allocate an encoded copy merely for an
instrument. At 2697bc6, `runModuleBody` calls the legacy `buffer` package's `Buffer.byteLength` for every body. Its
UTF-8 implementation builds a JavaScript array, pushing every encoded byte, then returns only the array's length.
This is additional work over the body read and V8 compilation, including prepared bodies; no native app-time
reading apportions its milliseconds yet. Use the existing Node buffer binding's allocation-free `byteLengthUtf8`
counter, which counts ASCII, multibyte characters, surrogate pairs and lone surrogates without creating bytes.
Keep all existing load-clock fields and their units. Add `linkSplit.utf8CountMs` and `compileSplit.sourceCaptureMs` /
`compileSplit.nativeEvalMs`, in milliseconds, with counts, to that same product trace. Capture and V8 time are disjoint
within the existing compile phase; the V8 span is indirect eval, including any parsing V8 performs there, and
does not claim to measure deferred parsing inside a later body invocation. Source retention and sloppy wrapper
execution stay the same.

The source trace also rules out a code-cache implementation on this route: each body uses indirect eval; no
`cachedData` API exists here. The substrate checklist closes C4 and L4 because confinement forbids exposing
`importScripts` and the guest's sloppy `with` wrapper cannot be an ES module. Those boundaries remain in force.
Resolve/read kernel time is already separate in the load clock; its ownership/read subdivisions are the substrate's
R1 ledger. Without the next phase readings, neither that work nor V8 can be named as the largest remaining gap.

Completion:
- The bundle and declarations compile separately within the coding lane's script bound; hooks stay enabled and
  the branch is pushed normally. No app, browser, World, test or timing runs here.
- The mini's paired app times establish the gain; phase and new split readings identify the next remaining cost.
  An unchanged or worse app-time reading leaves C6 open.

Builder evidence: the exact Vite bundle and `tsc -p tsconfig.build.json` declaration steps passed separately under
the nine-second subprocess bound. Ordinary hooks remain enabled; this checkout has no installed pre-commit hook.
No application, browser, World, automated test or measurement ran. Exact runtime counters and app-time gain remain
unverified; the code alone establishes removal of the legacy encoder's temporary byte array.
## J2-liveness: Signal-zero existence belongs to the caller's process authority

Status: active

Node's process.kill(pid, 0) checks existence without delivering a signal. The merged b94309e binding asks registry.signal(pid, "0") before self/child shortcuts, preserving signed targets and errors other than ESRCH. The shell's kill -0 still accepts a retained child handle as proof of existence and strips negative targets with Math.abs. Route that query through the same caller authority with its original signed target. The standalone owner answers from its own process map without invoking signal handlers. No app or package is recognized. Browser-substrate consumes this contract through its kernel Kill operation (ADR-0129/0131; Constitution Article 6).

Source attribution on substrate59da5903: runNodeOnItsTree and page-started line admission install the run's KernelRealmProcessRegistry; kernel-backed worker startup installs that registry for the realm. Its signal method invokes KernelVirtualFS.kill, where only ESRCH returns false; the kernel's shared process table resolves the target in the caller's namespace. A local child handle or a failed metadata lookup is unnecessary for a visible live sibling. The current pageRunsAreProcesses/forkerOf path requires each page-started Node child to have a kernel process. No fallback to a different registry's raw PID space is added. World's requested reclaimer-PID and client-holder instruments already exist in arc-world007a424/21d7eb6/2d1abd0. These are source facts; Twenty's earlier successful walks do not establish causality for the merged binding.

Completion:
- Library compilation passed (Vite library bundle and emitted TypeScript declarations); no incidental tests or runtime readings are authorized.
- The consumer integrates the source candidate and retains same-namespace peer, signed-target, zombie/reap and error-preservation evidence. That runtime proof remains owed.

## guest-immediate-binding: Bare immediates use the guest's Node timer handle

Status: active

Etherpad's pinned source f00f70cb85724b57588ebcf676be447d6d787fbe on substrate e1275d96 + tabnode 5a03c59 passed the previous compiler-thread startup failure, then tsx@4.23.15 failed in transformSync's cache initialization with `setImmediate(...).unref is not a function`. Both module wrappers bind bare timeout/interval names to the process's guest global, but omitted immediate names. Thus a bare call reached the realm's browser numeric handle. Bind setImmediate and clearImmediate through the existing guest timer face in both wrappers, as Node's module scope does. No package is recognized and no new timer implementation is added.

Completion:
- The queue reruns Etherpad on its recorded source and passes this exact timer-handle failure; its next stop or first HTTP is retained.
- Every other repository whose selected start reaches tsx or an immediate unref call is named and rerun on its source; a manifest mention alone is a candidate, not a proven reached call.

## esbuild-host-start: Finish compiler-thread attachment before admitting a guest

Status: active

Etherpad (db259afa + engine 905820e7) and Linkwarden reach a synchronous compiler call while the thread created by useHost has not attached its shared buffer. The substrate sends its initialized reply before that attachment; the guest then blocks the creator’s loop inside transformSync. Node’s synchronous native compiler runs beside the caller. The browser host must finish installing that compiler before admitting the guest. useHost now returns attachment settlement (including a startup error, which remains a call’s failure), and disposal settles the pending installation and retires the blob URL. The substrate companion awaits it in both init paths and drops it on disposal. No deadline is increased or added, and no package is recognized by the correction. No build or rerun proof yet.

Completion:
- Etherpad and Linkwarden pass the old synchronous-thread startup failure through the queue, with their commits and source recorded.
- Existing synchronous call and disposal deadlines remain unchanged; startup error evidence remains available to the caller.

## rejection-ownership: Deliver native promise failures to their process

Card t_94bcd252, task t_41f48f39, substrate Article 6: the accepted cold/repeat
profiles spend 0.10–0.21 s per busy process constructing missing-path errors.
The shared resolver's stat-only candidates throw for ordinary absence, and
the binding catches an allocated ENOENT even when Node requested
`throwIfNoEntry: false`. Preserve Node's nonthrowing stat contract down to
VirtualFS, use it for resolver candidates and internalModuleStat, and avoid
reading nonexistent package manifests. The substrate's packed adapter must
carry the same option. The owner forbids automated tests in this coding lane;
independent published-build review owns measurement. Disproof: ordinary absent
candidates still construct errors, or throwing probes/symlink errors change.

Status: active

Substrate constitution Articles 6 and 8. VS Code and its extensions receive their own asynchronous failures through Node's process
handlers, stderr and exit behavior. Ownership recorded at the identifier-constructor seam misses static,
chained, member-construction and native async promises, and restoring a broadcast would deliver unrelated
failures to every process. The owner-approved correction (substrate ADR-0037) gives each Node process, children
included, its own native JavaScript realm, reusing the substrate's worker and filesystem bridges, with World
authorization outside the guest. Process routing and the synchronous channel are connected; what the migration
still owes:
- descriptor inheritance across realms: browser acceptance of an inherited socket reaching the native open (the
  child's `guessHandleTypeOfFd` asks the native owner since `7f434c0`), listening-server transfer, and the V8
  serializer gap;
- native stream transfer (queued bytes, half-close, reset, pending IPC handles, duplicate descriptor lifetime,
  ref/unref, completion before teardown) and remote signals, with synchronous bind/open results preserved;
- shell-mediated routes traced so every Node child keeps its identity, and a child's recorded PPID validated
  against its admitted parent rather than a live parent token;
- cross-worker stdin behavior and full-process memory read in the browser.
Completion:
- Native, static, chained and member-construction failures reach only their originating process; handling preserves promise identity and suppresses default process failure; an unhandled failure reports stderr and ends that process without ending peers.
- VS Code's boot, extension logs, watchers, language service and terminal workflows are re-read after the correction (an isolated rejection command alone does not establish this).

## preview-workers-and-watch-encoding: Core editor runtime follow-up

Status: planned

Substrate constitution Article 6: blob-worker requests keep their creating virtual server, fs.watch keeps its requested filename
encoding, and a preview request forwards its Host authority (all in v0.5.0). Nested blob creation inside
workers and shared workers outliving their creator are unverified; the watcher process's first failure and a
renderer crash have no established cause.

Completion:
- Establish the watcher process's first failure and recover the crashed renderer.
- Verify blob-worker attribution across worker and service-worker lifetimes.

## follow-awaits-shapes: The await pass keeps every program it is given parsing

Status: planned
`__substrateFollowAwaits` (src/runtime.ts) only inserts, and a body that stops parsing after it fails in a tab where it
ran under Node. v0.5.42 fixed closings landing after the next node's opening at a shared offset; the independent
review that passed it, fuzzing 4,712 generated programs, found two older shapes that still break, the same before and
after that fix:
- A directive with no semicolon before a newline: `async function f(){"use strict"\nawait a}` gets the frame's take
  at the directive's end, before the newline that let the missing semicolon stand, and reads
  `"use strict"const __substrateAsyncFrame=…` ("Unexpected token 'const'").
- A `for await` under two labels: `async function f(){L:M:for await(x of y){continue L}}` wraps only the nearest label,
  so `L` names a block ("'L' does not denote an iteration statement"); the outermost label of the chain is the one to
  wrap.
Completion:
- Both shapes parse after the pass, and a generated-program harness over the pass's inputs (async functions, arrows,
  catch and finally, labeled and nested `for await`, directives, with and without semicolons) finds none that parse
  before and not after, with the fragments' removal giving the source back byte for byte.

## node-as-source: The engine behaves as Node, measured by Node's own suites

Status: active
Node's own fixtures drive the measurement (`scripts/node-tests.mjs`):
each module's current number is in `BUILTINS.md`. Each fix closes a class (what Node answers, deprecated or not), never a
fixture.
Completion:
- Every file in Node v24.21.0's `test/parallel` and `test/wasi` passes, except failures named individually as the harness's own or an evidenced browser constraint in `LIMITATIONS.md`. Every other failure is an open defect.
- `measure` reports zero unresolved native surface reads, zero unclassified native entries, zero unnamed test failures, and zero unattributed public export differences against real Node v24.21.0.
- An independent non-author review confirms every limitation; an overturned limitation returns to open defects.

## synchronous-children: Signals, timeouts and buffer limits for synchronous children

Status: planned
A synchronous child runs on a thread while the caller blocks on shared memory; `timeout` and `killSignal`
are ignored, and `maxBuffer` is reported after exit (ENOBUFS) rather than enforced, because there is no
process to kill; the browser path is written but unproven.
Completion:
- `spawnSync` and `execSync` honour `timeout`, `killSignal` and `maxBuffer` as Node does, proven on Node's fixtures in the tab.

## linear-module-edits: Assemble module edits once (t_9360174c / t_e24fccae)

Status: active

Substrate Article 6. Node loads generated modules without rebuilding their source once per edit. The reviewed Dub profile spends about 44 s in applyReplacements; preserve exact replacement ordering and assemble non-overlapping spans once.
Completion:
- The original Dub recipe runs this engine in the tab; replacement assembly no longer dominates preparation and generated bodies retain their semantics.

## process-module-path-cache: Share successful sibling module resolution (t_9360174c / t_83018b53)

Status: active

Substrate Article6 and engine correction toward Node. The retained World host spends0.863s inclusive in resolveModule; per-module require caches repeat sibling filesystem searches while Node shares successful paths across the process. Keep filesystem/process identities separate, missing/computed stand-ins local, and a bounded positive cache; replace exists-plus-stat with one stat. ADR0001 owns the decision.
Completion:
- The original Dub recipe reaches its real sign-in with this released engine and module-resolution work is reduced, with failures retained and the whole-load targets owned by c9.

## G1: Carry Node text across shared-memory seams

Status: built; consumer observation pending

Article6: merge the existing shared-text binding correction, preserving Node Buffer.write/toString/TextDecoder behavior for shared and foreign-realm buffers. The bounded scratch is sized to text rather than the whole destination, and copied decoding bytes cannot be replaced by Buffer.slice’s shared view. Consumer byte-copy reductions are implemented in the substrate; this engine commit makes no speed claim. Bundle and declaration compilation are the coding lane’s only verification.

## B6: Share compiled llhttp code with guest workers

Status: active

Substrate Articles 5/6: merge origin/w3/item-B6 so the engine creator asynchronously compiles llhttp once and structured-clones its immutable module through Runtime options. Parser instances, memory and callbacks remain in each guest realm; standalone callers retain their existing compile and refusal. No engine version, catalog or artifact publication belongs to this ARC.

Completion:
- Library bundle and declarations compile on the combined K5a/read-clock/G1/B6 engine line.
- The independently integrated engine is delivered to confined workers and records one compilation with N realm installations; runtime and speed proof remain unverified in this coding lane.

## E18: Preview navigation without a synthetic request

Status: source implementation; runtime qualification pending

Completion: the consumer frame is the first real HTTP client after a listening
port's mapping acknowledgement, with redirects and declared health gates intact.
`PortBridge.waitForPrimaryPortMapping` carries only metadata and a caller signal;
FIFO registration/primary selection and a current-channel acknowledgement prove
the mapping, including reconnect. Node's handler sees only real client requests.
An older worker must update; no GET substitutes. Actual document-response
metadata supplies unnamed-port selection. Consumer first HTTP remains the
frame's response, so cold route work moves rather than disappears. Compile the
library/declarations; independent consumer laps must establish behavior and gain.
## R5: send engine console instruments to the evidence owner

Status: source correction coded; runtime qualification pending

Articles 5/6/8/9; ADR-0124: the runtime's guest console wrapper now sends recognized instrumentation through the installed host evidence sink before the console/stdout transport. Ordinary output and standalone delivery keep their existing paths. R5/K5 below restores the previously inserted diagnostic block to unchanged Node bytes and moves its producer to owned source. Production library/declaration emission only; full R5 cost/delivery qualification remains independent.

## R5/K5: keep the request observer outside Node's bytes

Status: unchanged vendor restoration and owned observer coded; runtime qualification pending

Articles 5/6/8/9:9bd59f3/17a5dba inserted the diagnostic K5 counter/console block into the otherwise unchanged Node24.21 HTTP server. Restore that file byte-for-byte from495fed2, enforcing the repository's unmodified-vendor rule. Observe the actual scoped HTTP/HTTPS Server request emission from owned runtime source, with one shared process counter, first3 non-/__volter/ or /_twin/ requests, and the existing response writeHead capture. Preserve n/what/url/at/bodies/status and rounding; add pid to retain producer identity after document delivery. Send owned scalar fields to R5, with no producer JSON or duplicate stdout. Detach the emitter observer once its slots are used; preserve any caller's replacement. Request/return/error and writeHead delegation remain Node's. Production bundle/declarations and exact restored-source identity only; runtime delivery/cost remains independent. No authored implementation edits to Node's file.

