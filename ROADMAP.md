# tabnode roadmap (Volter's fork)

Open work on tabnode, Volter's fork of `macaly/almostnode`, Node in the browser patched toward Node as source. One
`## <id>: <title>` section each, with `Status:` and the `Completion:` lines that define done. The
measure is Node's own suites run against `dist/index.mjs` by `scripts/node-tests.mjs`
(`scripts/NODE-TESTS.md`); `BUILTINS.md` carries each module's number and what each remainder
is made of. The consumer is `volter-ai/browser-substrate`, which pins the engine by version and whose
changelog records what each version changed in the tab. What shipped is in
[`CHANGELOG.md`](CHANGELOG.md), one section per release; the fork's rules are
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`RELEASING.md`](RELEASING.md).

## fetch-body-source: Preserve finite Request bodies across a host transport

Status: local candidate; substrate W61 owns acceptance and release

Article 6, request-body regression correction: the substrate's
streaming transport consumes `Request.body`, which is a stream even when the
caller supplied text, bytes, a Blob or FormData. That erases finite-body metadata
before the browser upload and adds streaming restrictions to ordinary requests.
The existing Request constructor adapter now retains that source distinction
across construction and clone, for the host transport to preserve it. A finite
body already reaching native fetch as a Blob or bytes would disprove this cause;
the pre-correction substrate instead wrapped every supplied body in a stream.
The substrate's W61 records the bounded direct finite/streamed upload readings
and their limits. Library and declaration builds pass. No vendor source or
automated tests change or run.

## native-public-surface: Complete process-owned builtin exports

Status: local candidate; bounded browser reading complete, release pending

Article 6: the `0dc7d16` loader migration bypassed runtime.ts's completed builtin
table for native public modules. The browser reading lost `timers.promises`,
legacy timer functions and DNS error constants; `dns.promises` differs from
`require('dns/promises')`. A complete export surface in the process-owned native
factory would disprove this diagnosis, but `public-modules.ts` supplies smaller
objects than the old table. Move the existing timers and DNS completion into
their module factories and resolve promise aliases through the owning graph.
Do not return the old shared table or edit vendored Node sources. The browser
must show restored exports and alias identity, then successful timer completion.

The first corrected browser reading restores those names and identities, but
the ten-millisecond promise timer prints no value before the command exits.
The module factory still schedules realm timers, while `pendingGuestTimers`
counts only callbacks scheduled through the guest global view. Move that existing
tracking into a shared owner-bound timer adapter and use it for the native
module factory as well; retaining the untracked realm callback would disprove
the correction. This is process liveness, not a network or Chrome failure.

The corrected build's terminal reading restores timer/DNS aliases, all three
legacy timer function names and both DNS NOTFOUND constants. The identical
promise-timer invocation prints `timer-ok` before returning to its prompt.
Engine library/declarations, Node package and compiled VS Code example builds
pass. W61 records exact browser artifacts and the before/after receipt. This
does not establish full timers or DNS conformance or fix rejection attribution.

## rejection-ownership: Deliver native promise failures to their process

Status: browser failure reproduced; owner approved realm isolation; migration review pending

Articles 6 and 8. Required workflow: VS Code and its extensions receive their
own asynchronous failures through Node's process handlers, stderr and exit
behavior. Source attribution identified `0dc7d16`'s ownership filter as
incomplete: it recognizes only promises constructed through the identifier
constructor seam. Restoring the earlier broadcast would deliver unrelated
failures to every process and revive the observed IPC cancellation cascade.

The substrate W61 terminal reading on engine `7279bda` supplied five distinct
string rejection reasons and installed a process `unhandledRejection` listener.
Only `new Promise(...)` reached it. Static `Promise.reject`, a `.then` chain,
a native async function, and `new globalThis.Promise(...)` reached browser
diagnostics only. A 100 ms owned timer printed the collected reasons before
the command exited 0; the existing workbench remained usable. Delivery of all
five reasons to that process would have disproved the diagnosis. W61 owns
the exact command and artifact receipt. No automated test was added or run.

The existing AsyncLocalStorage shim explicitly cannot follow native `await`
reliably across overlapping runs. An active/last-process fallback is therefore
not evidence of ownership. Subclassing Promise previously broke native async
identity; observing with catch handlers changes unhandled-rejection behavior.
Extending only constructor or `.then` interception would still miss native
async promise creation and is not a complete correction.

Owner-approved correction (2026-09-23, substrate ADR-0031), implementation in progress: give each Node process
its own native JavaScript realm, including Node children, so promise/error
delivery has one process owner without replacing native Promise. Reuse the
substrate's existing worker and filesystem bridges; keep World authorization
outside the guest. This is more than enabling the existing confined-command
flag: guest Node children currently run engine-first in the same realm, and
the cross-worker child protocol does not carry the engine's IPC descriptors.
Before implementation, review process identity, IPC/stdio and descriptor
ownership, shared filesystem notifications, virtual ports/sockets, cancellation,
worker limits and boot/memory cost. Preserve worker_threads as threads with
their own existing parent error contract. Do not reroute processes until that
review establishes a concrete migration and incremental resource measurements.
The owner specifically asked about the weight of this change; approval is not
evidence that worker memory or startup overhead is small.

Migration trace (2026-09-23): all shell-launched Node scripts reach the engine's
`nodeCommand` in `shims/child_process.ts`; `startChildRun` currently registers
the child's IPC Pipe in the local `binding/fds.ts` table before running that
command engine-first. `binding/pipe_wrap.ts` implements Unix socket paths in a
realm-local map and transfers actual duplicated stream handles beside IPC
bytes. `binding/tcp_wrap.ts` similarly owns bound/ephemeral port maps, socket
names and live pairings. These are shared kernel state, not process-local JS
state that can simply be copied into another worker. `process-tokens.ts` also
owns PID allocation and liveness; independently booting that table would break
cross-process `kill(pid, 0)` and the VS Code lock-file workflow again.

Implementation order under the approved amendment:

1. Keep one container owner for PID/liveness, descriptor capabilities and
   TCP/Unix listener registries, beside the existing filesystem owner. Define
   the trusted host interface at the engine's native binding boundary. Bind
   each channel to its process at creation; guest-supplied IDs cannot select
   another process's descriptor or authority. Node's synchronous bind/open/
   liveness results require a synchronous worker-to-owner response; asynchronous
   stream events alone cannot implement that contract.
2. Carry native stream operations and descriptor transfer across that channel,
   including queued bytes, half-close, reset, pending IPC handles, duplicate
   descriptor lifetime, ref/unref, and completion before process teardown.
   Reuse the current libuv-shaped implementations in the owner and preserve
   Node's unchanged serialization and child_process library in each process.
   The existing page-net bridge only connects to numeric listeners and carries
   bytes/end; it is not a substitute for Unix paths or IPC handle transfer.
3. Route the Node command entry and engine-spawned Node children through native
   workers, passing explicit PID/PPID, stdio, IPC and cancellation. Preserve
   argv boundaries, preloads, eval wrapper files and inheritance. The existing
   confined-command worker already supplies shared filesystem access and host
   networking; extend that lifecycle without inventing another workspace store.
4. Measure one fully initialized process before switching the VS Code tree,
   then compare aggregate memory/startup against the current shared-realm
   candidate. Only after the process boundary is real can native rejection
   delivery replace the incomplete promise-tag filter.

This trace rules out merely enabling filesystem confinement or dispatching only
top-level `node` commands. The substrate W61 entry owns the module-only cost
reading and the owner's distinction between tens of MB and aggregate hundreds
of MB overhead.

Identity foundation (Articles 4 and 6): `process-registry.ts` now supplies one
container allocator and live table, with separate registration scopes for
worker realms. `process-tokens.ts` retains local run lookup and delegates PID
allocation, publication, release and cross-process lookup to that authority.
The process binding's fallback allocator uses the same counter. Repeated
publication/release of the same run is idempotent, but a realm cannot publish
an unallocated PID, replace another run, or claim another realm's parent.
The host can dispose a scope after abrupt worker death. Installation must
precede any process allocation. The substrate connects this seam to its
existing confined worker through a private synchronous channel; moving each
Node child into a worker, explicit cross-realm parent/descriptor inheritance,
remote signals and native stream transfer remain pending. Library and
declaration builds pass. The substrate W61 reading of the compiled candidate
restored VS Code and confirmed an ordinary fork's PID/PPID, IPC message,
parent/child liveness and ESRCH after exit. This covers the existing shared
realm after the registry change; the cross-worker channel is not yet accepted.
The reading also exposed child `node -e` entering the existing filename-only
command parser (unchanged by this patch); preserve eval/argv semantics when
implementing migration step 3. No automated tests were added or run.

IPC lifetime diagnosis (Articles 6 and 8; prerequisite of migration step 2):
the current `duplicate()` calls `takeOverFrom()`, which removes the sender's
peer. That answers a move, not two descriptors on one connection. In the
VS Code terminal on `aef0816`, a parent sent an accepted TCP socket to a child
with `{ keepOpen: true }`; the child wrote `child`, closed its copy and notified
the parent over IPC, then the parent wrote `parent` and closed its own copy.
The client printed `received=["child"]` and `final=["child"]`, losing the
parent's write. [Node v22's child-process contract](https://nodejs.org/download/release/v22.18.0/docs/api/child_process.html#subprocesssendmessage-sendhandle-options-callback) keeps the sender's socket
usable; the unchanged vendored library already implements the keepOpen branch.
The owning correction is the native stream binding: shared connection state
and queues with independent wrapper references, close on the last reference,
and a distinct move operation for opening inherited descriptors. TCP ephemeral
port lifetime must follow that same final reference. Both writes arriving
before correction would disprove this cause. Do not carry the move-as-duplicate
behavior into the worker bridge. Socket/server transfer and actual cross-worker
acceptance remain separate requirements.

The corrected binding separates shared connection state from wrapper lifetime:
duplication shares the unread queue and write-shutdown state; the final close
releases the peer and TCP port reservation. Opening an inherited Pipe still
moves its existing descriptor reference. The substrate's identical terminal
reading now prints `received=["child","parent"]` and
`final=["child","parent"]`, then returns to the prompt. VS Code itself restored
its workbench, Markdown preview, terminal and Git decorations on that build.
Library/declaration and example builds passed. This is a connected-socket
reading, not listening-server transfer or cross-worker acceptance.

An advanced-serialization variant stopped earlier in the existing `v8` shim:
`ChildProcessSerializer.writeChannelMessage` calls `writeRawBytes`, which the
shim's Serializer lacks. The bounded cleanup's `server.close()` reached the
same serializer error; the terminal returned to a prompt. Therefore this
reading does not exercise advanced handle transfer. Source also shows the
byte-write door dropped its optional handle (`writeBuffer`), whereas the Pipe's
UTF-8 write door performed duplication. The pending migration now forwards both
through the same native dispatch; the V8 serializer gap remains unresolved.
No automated tests were added or run.

Native transport implementation (migration step 2; Articles 4 and 6): a
`NativeStreamScope` retains the existing TCP/Pipe implementation in the owner,
assigns scope-local capabilities and exposes descriptor inheritance only to
the trusted host. The existing process-registry channel carries synchronous
native operations and asynchronous read/write completion. Required contract:
moving a process must preserve synchronous bind/open results, IPC handle
lifetime and bounded receive queues. Source shows those operations currently
depend on realm-local maps and object references; if the child path already
used host-owned descriptor capabilities, this diagnosis would be false.
Explicit registered-handle, chunk, per-connection queue and aggregate
pending-write ceilings bound this new path; reads require replenished credit
and writes wait for receiver capacity. Unread IPC descriptor copies have their
own per-connection count limit: a byte limit alone would allow many native
handles attached to tiny messages. Whole-tree resource accounting must include
these per-connection ceilings multiplied by the admitted handle/process counts.
This is inactive scaffolding until guest bindings and process dispatch use it.
Listening-server transfer, guest binding installation, cross-worker acceptance
and full-process memory readings remain pending. Library/declaration, substrate
Node package and compiled VS Code example builds pass; these establish
buildability only. No automated tests were added or run.

Guest binding migration (step 2; Articles 4 and 6): the TCP/Pipe constructors
and `LibuvStreamWrap` methods are also used by the native process binding for
stdio and IPC. Replacing only the exported `net` binding would leave those
paths attached to local pairings. Install one private transport before stream
construction and delegate at these shared native operations instead, retaining
the existing wrapper brands and Node's own JavaScript libraries. Read credit
must follow consumed guest buffers, writes must preserve asynchronous completion
and descriptor lifetime, and closing must wait for owner completion. The source
trace would be disproved if process-wrap stdio already used a distinct host
descriptor API; it currently constructs and pairs these same handles directly.
This work does not itself enable process routing or prove browser acceptance.
The private binding delegate now carries read credit, chunked asynchronous
writes, accepted/transferred handles, bind/connect/name queries, ref/unref and
close/reset. Local peer associations do not synthesize EOF: the owner delivers
bytes and EOF in order. Pending native requests retain loop ownership even on
unreferenced streams; shutdown follows accepted writes and close waits for the
owner acknowledgement. Buffer views are copied into owned Uint8Arrays before
transfer, since Node Buffer.slice aliases its backing pool. Concrete binding
constructors register after class definition to avoid a base-class import cycle.
The substrate's confined-worker bootstrap can install this transport before
container creation and negotiates protocol version 1, but the current host does
not enable it. Descriptor inheritance, listening-server transfer, process entry
routing and browser acceptance remain pending.
Library/declaration and downstream Node/example builds pass. The substrate W61
receipt identifies the browser-loaded artifact and the successful existing
shared-realm socket/fork reading; it also records the fresh-workspace observation
and the final inactive cleanup guards that have build verification only. No
automated tests were added or run, and no per-process memory claim follows.

Identity handoff trace (migration step 3; Articles 4 and 6): `startChildRun`
allocates and publishes a child PID in the spawning realm before execution;
the Node command reads that registered identity when creating its Runtime.
The destination registry currently rejects a foreign parent and an already-live
PID. Republishing or allocating a replacement would break the identity the
parent's ChildProcess already exposes. The trusted owner must move the existing
registration to an unused child scope without removing it from the live table.
Source and destination run tokens must be independent: carrying `child-1` into
the child's new realm would collide with that realm's own first spawned child.
This handoff belongs only on the host-held scope, never on its guest channel.
The disproving observation would be child execution already receiving a
host-admitted registration in its own scope; the original path used the local
`setRunPid` call instead. The host-only registry scope now transfers the live
registration atomically. Startup installation accepts that registration and
validates it against the destination scope before populating local run lookup.
An anonymous Runtime created during container construction cannot consume the
admitted PID. The substrate's existing realm launcher can carry the registration
under its request-1 token; actual child dispatch and descriptor inheritance
remain pending. This is an inactive migration seam, not cross-worker acceptance.

Completion: native/static/chained/member-construction failures reach only
their originating process; handling preserves promise identity and suppresses
default process failure; an unhandled failure reports stderr and ends that
process without ending peers. Re-read actual VS Code boot, extension logs,
watchers, language service and terminal workflows after the correction. A
passing isolated rejection command alone does not establish this completion.

Inherited-descriptor admission trace (Articles 4 and 6, ADR-0031): the native
owner can duplicate a connected handle under a child's fd, and delegated
TCP/Pipe `open(fd)` consults that table. However, the child's `guessHandleType`
still consults only local JS tables and calls every other fd above 2 a file.
Node's unchanged `net.js` selects TCP versus Pipe through that result, so an
inherited socket cannot reach the already-implemented native open. Local file
allocation also starts at 20 and can collide with an inherited fd at or above
20. A pre-existing owner-backed type lookup/reservation would disprove this
trace; neither exists. Correction: answer inherited type from the same scoped
owner table and skip its occupied descriptors during local allocation. Carry
explicit host-owned inheritance and resource limits through realm admission;
failure must dispose copied handles before any guest executes. This does not
yet cover listening handles or process dispatch.
Implemented at the native owner, worker binding and fd allocator; existing
raw-realm behavior takes no channel path. Engine library/declaration, substrate
Node package and VS Code example builds pass. Browser inheritance acceptance
remains pending, with automated tests off and publication held.

Node dispatch trace (Articles 4 and 6, ADR-0031): shell Node commands and
engine-first spawned Node children both reach `nodeCommand`; the general
child executor is bypassed by the latter. Dispatching only page requests would
therefore leave forked extension hosts in the shared realm. The shared entry
must offer the embedding host the parsed argument vector, named registration,
streams, cancellation, filesystem view and inherited native descriptors before creating a guest
Runtime. The process worker executes only its admitted local token itself;
other Node entries go to the host. The host receives arguments before the
engine's file-only parser, including raw eval/preload options from spawned
children or a wrapper already prepared by the source toolchain. Existing
all-Node dispatch at this entry would disprove the
diagnosis; it currently constructs a local Runtime unconditionally. The seam
remains inactive until the substrate connects admission and bounded lifecycle.

The startup-only hook is now implemented, with exactly one admitted local
entry per process worker and host dispatch for other entries. Source-local
registration cleanup runs on completion or failure without deleting an adopted
destination's identity. It has no installed substrate caller yet. The next
handoff must preserve live stdin (fork uses `RunStreams.stdin`, while the worker
bridge consumes an async iterable), input backpressure/cancellation, and the
source filesystem's prepared entry. Confined workers keep wrappers in private
runtime overlays: per-realm wrapper counters are not a shared-file collision
there. Do not change those names to address this handoff. Do not enable dispatch
until those interfaces, worker limits and descriptor ownership are connected.
Engine library/declaration, downstream Node package and VS Code example builds
pass. The hook remains uninstalled, so these are build receipts, not isolated
process acceptance. No automated tests were added or run; publication is held.

## terminal-descriptors: Allocated TTYs through the existing process host

Status: local candidate, bounded browser reading complete; release pending

Article 6: the substrate's unchanged terminal addon needs descriptor-backed
TTY streams and child stdio. Restore TTY descriptor attachment, fs.write on
stream descriptors, one allocation namespace for files and streams, and carry
terminal input and resize through the existing process runner. The embedding
addon owns its own ABI; the engine recognizes no package. The substrate's W53
records the observed integrated-terminal failure and owns the real UI reading.
No vendored Node files or automated tests are changed or run.

The first UI reading reaches command output, terminal dimensions, resize,
filesystem updates and independent terminal termination. It also exposes the
engine's internal process token in the host shell environment. Crossing the
host boundary must strip that private routing value: a later Node launch
otherwise inherits an explicit env assignment overriding its own stream token,
so raw output reaches the ancestor and the returned output is delivered again.
Ancestry stays in the existing process context. The substrate owns the rereading.
After stripping that token only from the host-bound environment copy, the
engine build and substrate package builds pass. In the substrate's integrated
terminal Node prints once without an internal marker, the shell no longer
inherits the token, and another terminal remains usable after the first exits.
Independent source review found no blocker. Node's suite remains unmeasured
under the owner's no-tests instruction; this is not a full TTY compatibility claim.

## process-owned-builtins: Guest builtin modules belong to their process

Status: local candidate; bounded browser reading complete, release pending

Production-import regression (Article 6, 2026-09-22): the compiled substrate
entry `index-DV8Cz_o5.js` throws `ReferenceError: Cannot access 'bufferModule$1'
before initialization` in `createCryptoModule$1`, before its toolbar exists.
The page's retained Runtime exception establishes an application import failure,
not a browser or Docker failure. Commit `0dc7d16` introduced factory-local eager
reads of the host Buffer module, Buffer and EventEmitter imports; these exports
belong to the loader's existing import cycle. The preceding implementation read
the Buffer module only at use. Development import order hid the new eager read.
Use the existing lazyModule/lazyExport functions to create host dependency
references inside the factory without reading uninitialized module constants;
retain the explicit per-process require path. The built page must pass this
same import and create its toolbar. A retained pre-toolbar initialization error
would disprove sufficiency; do not change browser settings or build minification.

Correction reading: the compiled `index-C156Frwx.js` imports and creates the
toolbar; the original pre-toolbar exception is absent. Through its terminal,
`node -e` prints `engine-alive 4` using `crypto.randomBytes(4)` and exits 0.
Engine library/declarations, engine typecheck and the production example build
pass without automated tests. Independent source review finds no blocker.
Full boot remains open: its server deadline expires before a worker run starts;
a later terminal invocation reaches port 49152 in 9.5 seconds. This import fix
does not claim to resolve the separately observed pack-placement delay.

Article 6: the substrate's W61 reading finds VS Code's HTTP patches in an
independent terminal Node command. `runtime.ts` hands every process the same
HTTP/HTTPS exports; `load.ts` caches the underlying files at realm scope.
The request subsequently creates its socket without a live process owner and
returns no callback to the terminal, despite a completed host exchange.

The correction is a process-owned module cache with recursively bound require
and process, preserving dependency and constructor identity. Keep the default
host/bootstrap graph private to the host. `fsModuleFor` is partial precedent:
its first guest still shares the host module and its internal requires still
reach the global cache. Lazy getters, hand-bound internals, native shim module
surfaces and `libRequire` paths must not escape to another process's graph.
Initialize the existing host HTTP adapter for each process's Agents using that
graph's http/net/stream classes; retain shared OS binding registries.
Independent review supports this ownership boundary. Copying HTTP exports,
resetting a vendor patch or adding a keepalive does not restore the contract.

Completion: independent Node commands see their own unpatched builtins while
the unchanged VS Code process retains its patches; the permitted HTTPS request
delivers a response or error through the existing World broker. The bounded
success reading below meets this reproduction; it does not establish complete
native-prototype isolation or all request-lifetime cases. No automated tests
are authorized.

Candidate implementation: all vendored files resolve recursively inside a
process scope, including lazy util exports, customization hooks and ESM
namespaces. The first guest no longer shares the host fs graph. The native
TLS, decoder and crypto factories, filesystem encoded-name results, stdin and
web-stream adapters use the requesting graph's constructors. OS descriptor,
listener and run-ownership registries remain shared. Host HTTP transport is
installed on each graph's Agent before guest code, with weak restoration
tracking. Native module data records are copied per scope; native/platform
function objects outside those factories are still shared implementations, so
this is not a claim of complete realm or native-prototype isolation.

Independent review found and corrected host Buffer results from crypto,
console-proxy property loss and unbounded per-process symbols on the shared
EventTarget prototype. The crypto factory's private key metadata accessor was
also corrected before building. Engine declarations, engine build and substrate
package builds pass. No automated tests were added or run.
The first rebuilt boot then failed before port publication: Node's `net.js`
tried to redefine `TCP.prototype.owner` on a shared native class. The owning
boundary is the same process graph: native class facades need per-process JS
prototypes over shared OS implementations, and accepted/duplicated handles
must use the relevant listener/handle constructor. This correction is now in
the candidate. Native facade `instanceof` deliberately recognizes the shared
OS implementation brand, so IPC-transferred handles remain valid in the
receiver without sharing guest JS builtin constructors. Independent source
review accepted this correction. In the next boot, the independent integrated
terminal command prints `request request get get`, crypto Buffer and stdin
Readable identity checks print true, and the unchanged GitHub HTTPS GET prints
`status 200`, `end` and returns to the prompt. `git status --short` preserves
`A core-workflow.txt` and `?? README.md`.

That candidate also left the remote extension host uninitialized: Markdown
preview stayed empty and the Git output channel had not registered. Source
tracing found another graph escape in child bootstrap: attachChannel invoked
the host graph's setupChannel, constructing received sockets in the host net
graph. It now uses the child's own unmodified child_process._forkChild, within
the existing run context. Independent review accepted this ownership correction;
engine and substrate package builds pass.

The subsequent normal-Chrome reading completes remote extension activation,
registers Git/GitLens/Markdown output channels, and renders the README preview.
With those extensions active, an independent integrated-terminal Node command
again prints `request request get get`, `status 200`, `end`, and the shell prompt.
The broker records one selected/completed GitHub relay attempt. Excluded Open
VSX and GitKraken destinations remain denied. Git still reports the preserved
staged sample and untracked README. Temporary debugger instrumentation was
removed. This resolves the observed cross-process patch leak and child bootstrap
graph escape; broader W61 transport acceptance remains separate and open.



## fetch-request-lifetime: Host fetch I/O belongs to its requesting process

Status: local candidate; bounded browser reading complete, release pending

Article 6: a terminal Node command's ordinary `fetch(...).then(...)` returns to
the prompt without output, while the broker records a completed direct GitHub
exchange. The same command with a five-second application timer prints its 200
response and clears that timer. This distinguishes premature run completion
from a transport or permission failure. The runtime exposes host fetch without
an owned request, and both module wrappers leave bare `fetch` outside the guest
global view. A transport failure with a live run would disprove this diagnosis;
the successful timed reading instead supports it.

Use the existing owned-handle registry and an explicit host fetch lifecycle
seam. Bind the process before entering the host transport; count pending headers
and actual body pulls, retaining cancellation ownership while idle. Release on
EOF/error/cancel and cancel on process exit. The existing broker stream source
observes all native Response consumption paths, so no Response imitation or
eager body draining is needed. Hold-through-EOF alone is incorrect: an unread
body has no pulls and would hang. Independent source review supports this shape.
No arbitrary promises, guest keepalive, network grant, or vendor patch is added.
Completion is the original direct-fetch command printing its result without a
timer, plus cancellation and unread-body exit through the terminal. No automated
tests are authorized.

The candidate adds a host-installed Fetch adapter with an explicitly bound
process context. Its request activities use the existing owned-handle registry;
the substrate worker accounts for headers and stream pulls through that seam.
Bare and qualified global fetch share dynamic process-local replacement;
normal direct-call receiver semantics are retained by the existing AST pass.
Review found and corrected failed pull-send cleanup and late requests from ended
processes. The weak process/token association distinguishes an ended run from
an unregistered library consumer. No native Response/stream object is replaced.
Other embedders must install the lifecycle adapter to supply this accounting;
the ordinary host-fetch fallback is unchanged. Engine and substrate package
builds pass. In the rebuilt existing normal-Chrome tab, the original command
prints `direct 200 5566` without an application timer and returns the prompt.
Headers-only fetch prints 200 and exits; the broker cancels its unread body.
Cancelling a native reader after a first chunk prints `cancelled true` and
returns the prompt. Native Response cloning returns equal bodies; a strict
process-local fetch replacement observes the original bare-call receiver and
matching global function identity. These are bounded worker-lane observations,
not a complete Fetch, relay-cost, or cross-embedder compatibility claim.

## http-client-host-transport: Node HTTP clients over an admitted host exchange

Status: local implementation in progress

Articles 5 and 6: connect Node's unchanged HTTP clients at Agent.createConnection
to a host exchange. Node's own HTTP server reads the internal request wire and
frames its answer; a bounded Duplex stream binding carries the bytes. The host
captures process attribution at connection creation and owns transport policy,
authorization, cost and cancellation. No application names or TLS certificates
are fabricated. Raw TLS remains unsupported. W61 in the substrate owns relay
capabilities, policy defaults and browser acceptance.

Completion: unchanged HTTP/HTTPS clients receive real status, ordered headers
and streamed bodies through the admitted broker; errors and cancellation settle.
No automated tests are added or run under the owner's instruction.

First substrate reading: the gallery GET returns bytes through the local native
relay. A broker denial exposed close-before-error ordering in LibuvStreamWrap:
its close callback ran before Node's queued error and ClientRequest reported
"socket hang up". Deferring completion behind that tick preserves the actual
error; the next live gallery POST reports "Failed to fetch". POST relay delivery
remains open in the substrate. The existing Readable.toWeb adapter ignores
backpressure and its strategy option, so bounded upload memory remains unproven.

## unavailable-tls-settles: Report unsupported TLS connections

Status: local candidate, not released

Article 6: a failed connection emits an error and closes instead of hanging a
Node HTTP client. In the substrate terminal, an unchanged `https.get()` gets
neither a response nor an error before its three-second application deadline.
The TLS stub was an EventEmitter that never connected or failed. The candidate
uses Node's Socket lifecycle and destroys it asynchronously with
`ERR_TLS_UNAVAILABLE`; its secure-connect callback never reports false success.
This is failure settlement, not the missing HTTP egress adapter. The substrate's
W61 owns that adapter and its transport-policy, header and streaming contract.

Measured in the existing substrate tab: the same request reaches its error
handler with `ERR_TLS_UNAVAILABLE`, clears its deadline and exits 0; the
workbench also reports its gallery HTTPS failures instead of hanging. The engine
build passes. No automated tests were added or run.

Completion: source review and release; the relay adapter remains separate.

## preview-workers-and-watch-encoding: Core editor runtime follow-up

Status: local candidate, not released

Article 6: preserve the creating virtual server for blob-worker requests and
restore Node's requested filename encoding at the fs.watch binding. The service
worker asks preview documents which created the object URL and derives the port
from the document, retaining attribution by worker client id. This covers blob
workers whose creating preview document remains available; nested blob creation
inside workers and shared workers outliving their creator remain unverified.

The browser-substrate UI run on 2026-09-22 reports no worker-module import errors
and its web extension-host output reports startup and eager extension activation.
The Parcel WASM watcher gets past addon resolution, but watcher IPC cancellation
and a subsequent renderer crash prevent claiming file notifications work. The
renderer crash cause is unknown; its guarded reload failed. Library build passes;
no automated tests were added or run, following the owner's instruction.

The owner-authorized Chrome reload recovered the existing tab. Its next reading
exposed unfiltered global unhandled-rejection listeners on every guest process.
The candidate filters rejection delivery by recorded ownership rather than
broadcasting to every process. Unknown provenance stays in realm diagnostics.
The build passes and the observed startup no longer reports the
watcher cancellation cascade. File notifications and the renderer crash cause
remain unverified; the automation library retains stale crashed-page state.

Release review correction (Article 6): the first ownership implementation
substituted a Promise subclass, making native async promises fail ordinary
`instanceof Promise` and `Promise.resolve(p) === p` checks. Assigning the guest
global Promise also reached the shared host while reads ignored the assignment.
The required behavior is native Promise identity plus process-local global
replacement. Keep the intrinsic constructor visible; tag only construction
through the existing identifier-constructor seam, using the original newTarget.
The global property and bare identifier must read the same local descriptor.
No handlers or species overrides are added. Identifier construction is covered;
member-expression construction, static/chained promises and native async
promises retain unknown provenance. No required VS Code reading established
species-chain attribution; the original non-broadcasting fix is retained.
An intrinsic identity mismatch or a replacement visible in a sibling process
would disprove this correction. Browser reading and build remain required;
no automated tests are authorized.

The corrected library build and typecheck pass. In normal Chrome's substrate
terminal, native async promises pass `instanceof Promise`, resolve identity
and constructor identity; assigning a callable Promise replacement is visible
through the bare name and receives `undefined` as its strict call receiver.
Restoring through `Object.defineProperty` is visible through the bare name.
That command then completes three Node HTTPS requests and exits 0; the VS Code
workbench and Markdown webview remain usable. This does not extend rejection
ownership coverage beyond the identifier-constructor seam described above.

The next live reading traced a terminal write through Parcel (39 ms to its
added event, 108 ms to normalization) and into Explorer (435 ms). The event
named authority `127.0.0.1:4189`, while the workspace named the guest listening
port `127.0.0.1:49152`. The service worker omitted Fetch's implicit Host header,
so the server substituted its listening address when generating the workspace
configuration. Article 6: the source candidate now forwards the browser
request URL's authority, restoring the Host an HTTP server receives. Explicit
virtual-host routing still overrides it. Engine and substrate package builds
pass. On the rebuilt document, a file created in the outer terminal appears in
Explorer without changing focus or pressing Refresh; deleting it likewise
removes it from Explorer while terminal focus remains. Source Control counts
the added file when the workbench regains focus, consistent with the Git
extension's own focus gating. No automated tests were added or run.

Completion:
- Read automatic Explorer and Source Control updates through the existing tab.
- Establish the watcher process's first failure and recover the crashed renderer.
- Verify blob-worker attribution across worker and service-worker lifetimes.

## launch: The repository goes public from its own first commit

Status: done 2026-09-21
The repository's history is its own: `main` began on 2026-09-21 at one commit holding the tree as it
stood, and `release` and its tags are cut from it. What the tree carries of its provenance is the
licence's, not the history's: `LICENSE` keeps upstream's notice, `src/node-lib/LICENSE` is Node's, and
`THIRD-PARTY-NOTICES.md` names the rest. The substrate pins the engine by version, and each version is a tag of
this history.

Completion:
- Done in `v0.2.14-volter.87`. The one file that named a package (`src/tailwind-vite-stand-in.ts`) left the
  engine: the loader and the bundler read the host's table of stand-ins, as the resolver already did.
  `npm run type-check` is clean over `tests/` as well as `src/`. Node's suite is run by
  `scripts/node-tests.mjs` in this repository. The repository is public.

## the-tree-is-the-engine: The repository is the engine and nothing else

Status: done 2026-09-21
The fork carried upstream's whole product beside the engine: a landing site and a docs site, seven
demo pages with their entry files, a hand-written Next dev server and a hand-written Vite dev server
(about seven thousand lines under `src/frameworks/`), a cross-origin sandbox runtime with its page and
its build, an end-to-end suite, three GitHub workflows, and a PM apparatus (`hermes/`,
`.open-autonomy/`) for a project run by pull request. None of it was reachable from the engine's own
doors, and the substrate imports none of it. Eight of the hand-written builtins that `BUILTINS.md`
already recorded as deleted were still in `src/shims/`, imported by `runtime.ts` and served to nobody;
four more files keep a builtin's name for a different job, which is the engine's process model, a
binding's table of host answers, the `node:zlib` a bundler resolves, and `createFsShim`.

Article 5 of the substrate's constitution is the reason the framework servers could not come back: a
framework's routing, rendering and hot reload are that framework's own code, run as a guest program.
Article 9 is the reason the records could not stay: a document that describes a tree that is not there
is not a record.

Completion:
- Done in `v0.2.14-volter.85`. The tree is the engine: `src/`, `tests/`, the records, the library build.
  What a guest gets is unchanged except where an imitation was shadowing Node's own module, which is
  written up in the changelog.

## node-as-source: The engine behaves as Node, measured by Node's own suites

Status: active
Node's own fixtures drive the measurement (`scripts/node-tests.mjs`):
`test/wasi` stands at 7 of 12 and `test/child-process` at 45 of 109 after synchronous children landed;
`test-path-` is 16 of 16. Each fix closes a class (what Node answers, deprecated or not), never a
fixture. The shell's text-patch layer is already deleted; the gate measures the fork alone.
Completion:
- Node's `test/wasi` and `test/child-process` suites pass in the engine, with every remaining failure recorded as an evidenced platform constraint, and `test-path-` stays at 16 of 16.
- `browser-substrate`'s node-adapters gate passes on the fork alone.

## synchronous-children: Signals, timeouts and buffer limits for synchronous children

Status: planned
A synchronous child runs on a thread while the caller blocks on shared memory; a signal, a timeout
and a buffer limit are not honoured because there is no process to kill, and the browser path is
written but unproven.
Completion:
- `spawnSync` and `execSync` honour `timeout`, `killSignal` and `maxBuffer` as Node does, proven on Node's fixtures in the tab.

## fork-maintenance: The fork stays a fork of upstream

Status: proposed
Completion:
- A change taken from upstream arrives as a patch with the reason at the site, and `dist` is rebuilt after every release so the suite cannot lie.
