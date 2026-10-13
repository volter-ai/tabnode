## Native addon advisory file locks

Articles 5/6/9. Restore the real OS locking available to native addons over the existing TREE_DESCRIPTORS capability. Optional record-lock and flock operations are exposed only at a private symbol in the fs binding, never a second lock table or a guest-global hook. Record locks belong to a process and end on any close of that file; flock belongs to an open description. Unsupported owners refuse ENOSYS. The substrate owns ABI translation, and the real-image reading remains separate. Lead m-aaf65f6e; no tests or apps.

## S2 R5: bounded retained diagnostic inputs

Status: source implementation and full package production emission complete; application delivery/cost qualification pending

Articles5/6/8/9; substrate ADR0124 and lead ruling under owner delegation,
2026-10-12 (OWNER-RULINGS.md). Keep the exact deferred decoded-body UTF8
counts, but declare all retained body text/code-unit and row metadata weights
to the selected host's allocation within the tab's single 256 MiB trace retention owner. A dropped source
cohort releases its entire prefix array and all associated factories. Later
load clocks retain their phase/count scalars with explicit null byte totals;
no partial prefix is presented as exact. Normal terminal materialization
preserves its cohort, releases diagnostic inputs, and retains cumulative
scalar byte totals. Old hosts ignore the additive local sink arguments.

The compact successor must carry authenticated decoded-body UTF8 lengths
beside prepared-body digests at preparation. Raw file lengths cannot replace
decoded UTF8 lengths after BOM removal or malformed-byte replacement, and
digests alone do not encode a length. The withdrawn raw-reader prototype has
no source delta in this unit. No boot-time UTF8 scan, guest scheduling/cache
change, tests or new measurements; consumer qualification is independent.

## S2 K1: reuse internal require contexts

Status: approved source pushed at 912010ec; full production bundle/declarations emitted; matched Cal reading pending

Substrate Articles 5/6/7/8/9. The paired substrate reading
docs/readings/s2-k1-cal-stage-account-2026-10-12.json at 6bda016e
retains Cal fe60311f+a279af1's median first request to head of 3645 ms,
including 1383 ms resolution and 8104 new bodies. Its live require hook
reaches the engine's prototype require 26560 times. The original Module._load
calls requireFor(parent) on every turn, constructing the entire createRequire
closure graph even when the parent and module cache already exist. These
counts establish a repeated construction path, not its exclusive time.

Reuse only the engine's private internal context for an admitted parent with
an own string filename, inside the owning module-cache class. Re-read that
filename and replace the context when it changes. Arbitrary parents, filename
accessors and public Module.createRequire retain fresh construction. Preserve
live Module hooks and parent/children/export identity. Clear the context's
invocation-local resolution and package maps before every internal use and
restore createRequire's currentVfs binding; no miss gains a longer lifetime.
Existing process-owned successful paths and Node package-config absences
remain unchanged. Weak parent ownership retains at most one context per
parent, with no global path or permission cache.

Independent review approved the frozen source, including reentrancy, transient
miss lifetime, ownership and guest visibility. Two retained tradeoffs: each
createRequire also allocates its private reset closure and WeakMap entry; an
internal cached call no longer repeats the factory's repair of a deleted
process.getBuiltinModule. Public/fallback factory calls still run that code.
The private context is distinct from the module body's public require, so its
reset cannot clear that public function's local caches. No guest-visible
require function or evaluated exports are newly shared.

Production library/worker bundle and declarations only; no tests, probes,
application or timing runs here. Independent review precedes integration;
the mini's matched capture determines any saving. The native 6.028 s comparator
in this old cohort ran through World and remains subject to N9's restatement.

[The production receipt](docs/readings/s2-k1-cal-require-contexts.json) binds
the unchanged full Vite library/public and runtime-worker build (exit 0) and
all package declarations (exit 0): 159 products, including 151 declarations,
10,243,584 bytes. Original source/config/lock bytes and all completed products
are retained in measured archives. Two full installs and the first bundle
stopped at their recorded bounds; those attempts remain explicitly incomplete.
The own compiler closure was installed normally from registry/cache, with
every selected version/URL/integrity matching the original repository lock.
No repository manifest, vendor source, package pin or publication changed.
Container hostname follow-up: full engine declarations pass; changed module JavaScript emits through the pinned esbuild transform. Whole Vite bundle stopped8.5s and remains incomplete. Substrate runtime/WALI/Node/image-manifest/container-start changed closures emit, including both filesystem forwarding wrappers. Setter admission still awaits the shared capability model. No apps/tests/qualification.

Container hostname compiler limit: own exact locked production dependencies installed successfully; full Vite bundle and declaration emitters stopped at7s, neither a pass. Retain an incremental production emitter as tool-speed work; private hostname reader source is ready for independent review, runtime savings/qualification unclaimed. Substrate docs/readings/container-uts-hostname-implementation.json retains exact receipts.

Container UTS hostname: Node's native OS binding must ask the calling process's kernel-owned UTS through its own filesystem channel. The host supplies a private per-process reader; it is retained by the binding and never inferred from mutable process.env, pid getters or the hosting realm. Standalone VirtualFS retains localhost. Vendored Node JavaScript stays unchanged. Substrate ADR-0129 and docs/readings/container-uts-hostname-ruling-2026-10-12.json own the namespace, creation files and setter permissions: lead ruling under owner delegation, 2026-10-12, OWNER-RULINGS.md “decisions are delegated to the lead”. This record precedes behavior. Runtime qualification remains the cycle's reading.

## S2 first request: partition the time outside module loading

Status: source instrument coded; production emission and independent reading pending

Substrate Articles5/6/8/9. The retained Rallly fe60311f+a279af1 median
request-to-head interval is1,294.7ms. Its662 new prepared bodies add441ms
of native eval and468ms outside module phases; the filesystem's cumulative
blocking accounts for14ms of that outside interval. The remaining454ms has
no operation attribution. C4/L4's confined sloppy-wrapper boundary remains:
prepared text and verified artifacts are not serialized browser code caches.

Add a requested-only, fixed-size outsideSplit to the existing deferred
load-clock record. Intersect outside intervals with the current VM phase and
the engine's existing realm guest-execution brackets. VM parse/setup/eval,
other bracketed execution and the unbracketed remainder partition outside;
filesystem blocking stays a nested overlay. Brackets name engine dispatch,
not CPU time, and the unbracketed remainder can contain host work as well as
waiting. Native continuations and simultaneous processes in one realm retain
that explicit scope. Never infer an await or scheduler cause from it.

Close intervals at existing load and synchronous VM boundaries, with scalar
counters only: no polling, source/stack retention, timers, handles, guest
hooks, cache format, wrapper or scheduling change. Unrequested paths do not
read an additional clock or allocate this account. Preserve every existing
load-clock field, deferred byte accounting and snapshot ownership. Production
bundle/declaration emission only; the scheduled mini reading determines
which operation class can actually be removed. No saving is claimed here.

The account uses the host timestamps already read by the load clock; reading
the existing bracket total neither starts that loop nor reads another clock.
clippedBracketMs reports active deltas bounded to their wall interval,
including quiet's existing omitted tail. Deferred body-byte materialization
is excluded from both wall and bracket totals. VM phase boundaries close only
an existing module clock, so they cannot move its first-require origin.
Snapshots copy the scalar partition before deferred transport; no later VM
or guest callback can rewrite an earlier boundary's reading. Scope remains
the owning process's module clock intersected with its realm's dispatch
account; another process running in that same realm can contribute brackets.

## S2 K5b: Reuse VM preparation and attribute execution excess

Status: generic reuse and process-owned phase capture compiled; independent review and next-lap attribution pending

Substrate Articles5/6/8/9. [K5b's source and profile reading](docs/readings/k5b-execution-2026-10-12.json)
retains the historical4.1–4.6s evaluate+outside tab figure against3.1–3.3s
native. Its matching tab logs were not retained; no exact current-head phase
or saving is inferred. The native4.470s profile is retained with its raw hash.
VM ancestry accounts for983ms of samples, including script/context creation
and guest execution below it; CommonJS wrapSafe ancestry accounts for818ms.

Intent before code: Node's Script keeps compiled preparation, while our
runInNewContext reparses declarations with Acorn and reconstructs the same
helper Function on each run. Reuse immutable declaration preparation by
source in the owning process/realm, reuse the evaluator in its
realm, and create a fresh sandbox/global/scope and activation for every call.
Never cache evaluated exports or context objects, share a Script across realms,
change app/library bytes, or expose importScripts/cachedData as a code-cache
substitute. Add exclusive parse/setup/eval counters beside the existing deferred
load clock, with actual process ownership and nesting accounted once. Eval
includes browser parsing and guest execution; it is not a compile-only clock.
Preserve return/exception/declaration behavior and current option handling.

Builder evidence: [the source/production receipt](docs/readings/k5b-execution-build.json)
binds the actual Vite runtime graph (384 modules,2.11s,exit0) and all151 package
declarations (exit0). The full public/worker bundle stopped at7s and8.5s and
is not a completed pack. The focused graph uses the original config/plugins/
flags and emits every changed VM path. Locked production/compiler dependencies
installed normally in3s after two full installs stopped at7s; no repository
lock or published0.9.0 pin changed. All155 emitted products are retained.

The cache holds immutable declaration preparation, never a compiled Script
or sandbox. Script instances retain their own preparation; process-local
shared values are weak, and finalization removes their source keys. Keys use
exact source alone, reading no option getter or value and retaining no option
buckets. Parser options remain constant and existing VM options are otherwise
unchanged. A conservative no-var/no-function/no-escape source scan
skips impossible declaration discovery; possible declarations use the original
Acorn parser. Each eval receives a fresh declaration array as well as fresh
sandbox views and activation. One frozen evaluator Function and frozen prototype
stay in their own realm; the actual evaluator receives the captured source.

Independent-review correction: merge R5 producer head e89b8d4 and gate VM
phase/run/preparation observers before clocks, timestamps or counter allocation
when no reading is requested. The original 84ad5425 receipt remains retained;
[The correction receipt](docs/readings/k5b-execution-review-correction.json)
binds successful runtime-graph and entire package declaration emissions, with
all corrected sources and emitted products retained.

vmSplit accompanies the existing deferred load-clock line only when requested. It records exclusive
synchronous parse/setup/eval phaseMs and calls; context/thisContext runs; UTF16
codeUnits; cacheHits/cacheMisses; acornParses/declarationScanSkips/parseFailures.
These phases overlay module phases, so their milliseconds are not added to
module wall totals. Eval includes browser parsing, guest execution and nested
loads; returned asynchronous work is outside the synchronous VM span.

Completion: ordinary hooks-on source push, independent engine review, full
consumer pack emission, then the mini's next five lap names real cache hits,
phase costs and boot/walk behavior. No tests/apps/probes/new timing runs here.
No app-time gain is claimed. K5c's compile/evaluate ceiling remains a separate
follow-up under C4; actual direct eval stays, with no imported/cached guest code.

## S2 R5: request instrumentation at its producers

Status: requested producer unit emitted and pushed; independent delivery/cost reading pending

Independent-review correction implemented (Articles5/6/8/9): preserve an old
substrate host sink's default reading when neither selection symbol exists;
propagate the explicit request through the authenticated cross-origin iframe
hop. Failure warnings/errors remain reports when readings are off. Select
the page's first-page snapshot and require-path counters at their producers.
Early dedicated-worker record delivery remains an independent live reading.

Articles 5/6/8/9; ADR-0124. Deferring serialization leaves unconditional
per-module/per-filesystem timestamps, diagnostic maps and quiet timers in boot.
The retained inventory names265 matching sites in60 source files at substrate
9c50cad5 and engine d82b143. The high-frequency classes are module phase/read
clocks, resolver probes/package-config counters, kernel exchange/path/read
costs, and socket evidence. Boot receipt payload helpers can themselves issue
getcwd/stat/read calls before their queued output is captured.

The host requests a realm's diagnostic readings before its program starts.
The existing trace attachment carries that request independently of execution
ownership. Producers return before diagnostic timestamps, per-operation
allocations/counters and timers on an unrequested path. Preserve all functional module caches, filesystem
search proofs, admission/liveness deadlines, transport accounting, ordinary
program output and capture/retirement ownership. The dry-run explicitly asks
for the existing complete reading so the independent mini laps retain their
fields; ordinary product openings do not. The driver supplies the request to
its paused targets before resume, and child trace attachments inherit it.
Older trace clocks must retain their documented reading rather than silently
losing it. No vendor Node bytes, graph semantics, credential/policy or pinned
package change. Producer inventory is source evidence, not a measurement.

Completion: source gating throughout the named producer classes, engine and
production package emitters, ordinary pushes and an independent reading of
both selected record delivery and unrequested cost. Raw blocking/terminal
checkpoint transfers and a global retention bound remain distinct open parts
of R5; a64-record transport batch is not a bound on retained evidence.
## S1 CJS module.load delegation (2026-10-12)

Status: production bundle/declarations compiled and bounded independent source review cleared at freeze3. Unchanged image qualification pending.

Articles5/8/9; engine invariants: the retained Wekan image60f4ee53 on6990d634/d82b1431 throws in npm-require.js:57 with an absent pathIsAbsolute function. Original Meteor3.6-rc.0 runtime.js:35-43 wraps Module.prototype.load to call the unchanged Reify0.25.4 runSetters after loading. The engine inserts the module into its cache but calls the extension handler directly, bypassing that wrapper. mini-files registers getters before initializing its const path exports; Reify's completed-load setter publishes them. These source paths establish a matching mechanism; the original run did not capture its resolved mini-files input or export identity. Node24.21 CJS loader.js:1348 calls module.load, which selects the registered extension at1542. Restore that delegation for every uncached file, keep cache-before-evaluation and actual module.exports identity, and remove failed loads from the cache/parent children. Pending loaded-state decisions use engine-owned module bookkeeping, without inspecting arbitrary guest exports. A late rejected body retires only that module's cache generation and original admission parent edge, independently of nested hooks replacing shared compile callbacks. Keep the existing longest registered extension selection. Neither package-config absence caching nor image preparation needs changing for this source-proven bypass.

A newer pre-fix take on d490248d reports a committed-exec reactor-descriptor retirement timeout and no application stderr/load-clock lines. It supplies no positive Meteor call boundary and no evidence of intermittent Reify behavior; the kernel lane owns that earlier stop ([retained reading](evidence/module-load/d490248d-reading.json)). The module.load correction receives no runtime credit from it.

Disproof: a retained resolved-path/body witness shows a different mini-files input or a called completed-load wrapper with its initialized exports still absent. Completion: production bundle/declaration emission and an independent frozen source review; the sweep's unchanged real image supplies behavior, never a synthetic app/module probe.

## S2 R11: Keep missing package configurations for the process lifetime

Follow-up intent (Articles5/6/8/9): the independent read cleared befbc6c,
merged with substrate772e4b9b, and identified inherited scope overreach.
Node24.21 src/node_modules.cc:311-350 stops TraverseParent before root and
before a directory whose leaf is node_modules. CJS loader.js:662/1529 uses
that binding for self-reference and #imports. Bound both shared resolver
walks the same way, ending #imports at its nearest config even when it has
no imports map. Keep installed-package LOAD_NODE_MODULES/global-root search
separate. No cache invalidation or new instrumentation is needed.

Kernel-backed stat source check: KernelVirtualFS.statAtNow returns undefined
for syscall-2/-20 only, and throws all other negative results; missing()
recognizes only ENOENT/ENOTDIR. Local absence requires a searched current
namespace witness; an unavailable/denied search returns to the kernel. The
kernel therefore already throws EACCES/EIO, so change no kernel behavior.
Document the same undefined-only-absence contract on ResolutionFs.statSync.
Disproof: a scope reads /package.json or crosses node_modules, #imports
escapes a nearer config, or an EACCES/EIO becomes a retained config miss.
Follow-up builder evidence: owned install0 and actual build:lib0 produce
158 files, including150 declarations, under5120MB preflight/plain mutex.
Production bundle/declarations and ordinary push are the coding evidence;
independent first-request/cache-hit/gain qualification remains owed.


Status: production library bundle/declarations pass; independent static read and first-request qualification pending

Substrate Articles5/6/8/9. Three retained LibreChat6fd6febc quiet clocks
put resolution at1179/1224/1307ms, beside29015 absent engine stat probes;
the native first-head phase arm reports242ms. The old clocks do not identify
which missing candidates are configs, and their outside times are not a
matched first-request capture. Input hashes and boundary limits live in
browser-substrate docs/readings/s2-r11-resolution-reuse-2026-10-12.json.

Required Node contract: v24.21.0 src/node_modules.cc:95-110 returns the
BindingData package_configs_ entry even when it is nullopt;115-135 inserts
nullopt for ENOENT/ENOTDIR/EISDIR. There is no invalidation during the realm's
life. A config created after its earlier absence stays unseen in that process.
The engine retains parsed configs but clears nulls at every resolution,
repeating nearest-parent package.json probes for different import specifiers.
ResolutionKept.probes.absent increments only in the engine resolver's ask;
KernelVirtualFS's nested view-search checks own separate counters.

Intent before code: retain only proved missing configuration facts with the
existing process owner and actual filesystem resolver. Directory configs and
ENOENT/ENOTDIR/EISDIR read failures count as missing; other stat/read errors,
malformed configs and arbitrary non-file nodes do not become persistent
absences. Leave general missing-module/stat candidates and their cache
lifetimes alone. No invalidation, application/profile/name exception, policy
change or negative module-resolution cache. Add scalar package-config lookup,
positive/negative-hit, check/read and retained-absence counts to the existing
deferred module clock. No new timer, hot JSON producer or guest execution.

Disproof: a later config becomes visible after a cached miss, a fresh process
or different filesystem reuses it, invalid/unreadable configs are retained
as missing, or config-only caching makes unrelated file misses sticky.
Builder evidence: own locked npm ci and actual npm run build:lib exit0,
with the plain compile mutex and5120MB disk preflight. All158 products,
including150 emitted declarations, are retained with source/compiler hashes.
No vendored Node library, application, installed0.9.0 pin or shared catalog
was changed. Negative facts live in ResolutionKept.missingManifests, keyed
by the actual filesystem, and survive resolver reconstruction and stat-window
closure. resolveSplit.packageConfigs names lookups, positiveHits,
negativeHits, checks, reads and missingKept. checks is an uncached config
lookup, which may use an already held stat; it is not a kernel syscall count.
Other parse/read/stat-error behavior remains outside this cache-only unit.

Completion: actual production library bundle/declarations, hooks-on commit
and push; independent static read and current-head first-request capture
qualify behavior, removed probes and any gain. No tests/apps/probes/timings
in this coding lane. The total5.5-6.0s backend gap remains unqualified.

## S2 R11: Capture a server's module clock at its first HTTP boundary

Status: source library bundle/declarations compiled; independent first-request delivery and phase reading pending

Substrate Articles 5/6/7/8/9: LibreChat's retained ff89a4c4/3fd5031
server answers after 5.54–6.01 s from its worker initialization, loading
6173 bodies. Its native phase arm loads 6171 bodies and answers after
2253 ms since first require, with its ESM coverage gap retained. The tab
has no load-clock record, so no remaining phase can be attributed yet.
Source readings live in browser-substrate ffa1726e,
docs/readings/s2-r11-librechat-2026-10-12.json.

Intent before code: use the existing process-owned, bounded K5 observer
to capture the same private module clock at the first request and first
successful writeHead. Capture scalar request identity and phase fields;
defer body byte totals through the existing R5 evidence owner. Boundary
samples do not consume/suppress quiet or exit records. Native-stream
clock capture remains as it is. Delegate to Node's unchanged request
and writeHead implementations, without a second observer or guest timer.
No project/package recognition or changes to HTTP or loader scheduling.

Builder evidence: own locked npm ci and npm run build:lib both exit0.
The actual Vite library bundle and TypeScript emitted declarations are
retained with every emitted worker/helper product in the owned
s2-r11-librechat-artifact/engine-production-receipt.json, SHA-256
2c2de0a33b83dcb7f71fe7e117527b2bf0cd440bb6c770f032b4fc72f53ac18d.
No runtime delivery, speed gain, tests or app/probe execution is claimed.

Completion: actual library bundle and declarations emit; ordinary hooks,
commit and push; the independent cycle joins first-request/head body and
source/phase fields to native. Runtime delay correction remains pending
that attribution. No tests, probes, apps or new measurement runs here.

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

## R9: complete fully accepted native stream writes synchronously

Status: post-merge follow-up built; production bundle/declarations pass; Dub reading owed

Substrate Articles 1/5/6/8/9. Retained Dub ff89a4c4/16fdf1aa records show
the first 249-byte write accepted by its native owner, then its worker's
MessagePort completion handled 5669/5456/5248 ms later. NativeStreamDriver
forces every remote write asynchronous. Node v24.21.0 StreamBase::Write
(src/stream_base.cc) first calls DoTryWrite and reports async=false when all
bytes were accepted; stream_wrap.cc preserves queued writes on EAGAIN.

Restore that native seam through the existing synchronous operation channel.
Try only a whole write within one bounded chunk, with no descriptor send or
earlier queued write. The owner accepts it only with actual receive capacity;
EAGAIN mutates nothing and retains the existing ordered asynchronous path.
Success sets the native async flag false, releases the request once and leaves
Node's own JS to call its callback. Larger writes, capacity waits and descriptor
sends keep their current bounded queue. Preserve sampled vector/chunk evidence
with a scalar synchronous field. No guest scheduling, vendor bytes, stream
authority, resource ceiling or timeout changes.

Completion: production bundle/declarations and the paired substrate compile;
independent review checks write/callback/descriptor lifetime; the next Dub
source-route reading establishes completion and first-response behavior.

Review correction: native transport failure returns ECANCELED/EPIPE through
the normal synchronous write result, including the completion sample, without
throwing or replaying. A new bounded transport method waits at most 1 ms for
full acceptance. If the owner has not answered, an atomic per-write handoff
leaves that same submitted buffer owned by the ordered async path. A Promise
result is its one completion; the driver never resubmits it. Older transports
without this bounded method remain async. The substrate owns the named wait
constant and atomic protocol; no process/module-specific restriction.

Post-merge review follow-up: queue owner-stop delivery as binding work after
the current guest call returns, preserving EPIPE for a failure discovered in
that call and preventing read/close re-entry from inside socket.write. Ignore
late submitted or ordinary chunk completions after their write already ended;
they must not change bytesWritten or send another chunk. The paired transport
pauses try-write for a fixed100ms channel window after an async handoff, using
only a monotonic comparison and the existing async path. It keeps conservative
channel-CLOSED priority over a racing DONE result, with no byte replay.

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

Status: already on the engine head as 6ce7c9f; D3 1418c013 owns named-loop completion. Coordinator closed the phase-1 code row on 2026-10-12; no gain or five-app empty-span proof is claimed.

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

2026-10-12 audit on f8948f7: [retained readings and source hashes](docs/readings/s2-d2-2026-10-12.json)
cover 17 mini logs: Twenty 4, Rallly 4, LibreChat 4 and Dub 1 from ff89a4c4
directories, plus Cal 4 from the archived f65c4b79 directory. Cal's current
runs directory was empty; its archived arm is labeled separately. Rallly 4,
Dub 1 and Cal 8 supply 13 drain records. Each ends by the referenced loop
being empty, with emptyLooks=0, wokeAfterEmpty=[] and lastEmptyMs=null.
Twenty and LibreChat have no drain record. These logs observe no timed
empty span, so the empty arrays do not establish the original five-app D1
condition. D3 reaches its completion checkpoint before scheduling a look.

The recorded world-runtime URL drains in Rallly, Dub and Cal belong to
later walk steps, after first HTTP. Cal's other drain, Node pid14 running
npx ts-node --transpile-only /calcom/scripts/seed-app-store.ts, completes
before yarn start and is on its first-page path. Its host-exec request
uses pid10029; retain both namespaces instead of equating those numbers.
The World's up drain stays beside the app after its last line (substrate
packages/browser-substrate/src/index.ts, E5); a persistent server's exit
is not a prerequisite for its first answer. No additional cut was made.
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


## Requested host-only module evaluation witness

Substrate Articles1/2/5/6/8/9; lead m-d9a81ee0/m-ff114e61. A consumer's
Module.load prelude left its evidence emitter in guest globals, allowing
guest Node to forge provider-loader evidence in the shared V8 context.
Node's host debugger observes execution outside its program's globals.
Provide the analogous host-only, requested module-evaluation callback in
Runtime/RunOptions: select exact filenames once, observe only after the
engine's original synchronous module body completes, and keep callbacks
inside host options/closures, never Node globals or Module exports.
Unrequested execution installs no body wrapper or per-load check. Preserve
original loading, exports, errors and source; no package/framework names,
source patches, vendor calls or diagnostic environment flags. The consumer
privately captures/removes its CDP binding before guest entry and attests
the actual process root. Production library/declaration emission only; no
tests, probes, apps or timing runs. Runtime observation remains unqualified.

R5 review correction: every refused source input explicitly drops its byte
account; terminal materialization retires only its captured prefix and keeps
any later bodies. The host partitions one tab budget across its realms.

Container UTS resolver correction (ADR-0129): process-owned /etc/hosts readers now feed callback/promises lookup through the captured NodeLibScope, preserving file address families. Changed JS modules and complete declarations emitted. Paired merge with substrate is required; whole Vite bundle still incomplete and cycle reading pending.

Container hosts-error follow-up (m-5b8a48e2): missing hosts no longer becomes an empty string at capture, and EIO is not suppressed. Production all declarations and changed JS emit; cycle qualification pending. Receipt /Volumes/PeakSSD/heavy-runs-out/builders/s1-container-hostname-artifact/hostname-hosts-error-followup.json SHA256 e128facd7b9414c88c819a0224c1e7878ad230eaf1b4a27f9989ed6eab5430bd.

PLACEMENT-LOADER-INTRINSICS intent (substrate Articles1/2/5/6/8/9; lead m-76ea3240): capture native Reflect/Object/Set functions before any guest replaces shared-realm builtins. Populate selection without mutable iterables and inspect own module state descriptors. Preserve original evaluation and unrequested bodies; no target execution. Consumer JSON output captures native intrinsics and avoids inherited toJSON hooks. Guest-writable file contents remain writable; inspector paused-worker transport is an independent product reading.

PLACEMENT-LOADER-RECORDS intent (substrate Articles1/2/5/6/8/9; lead m-207bb67f): replace observer filename arrays with private host predicate selection over frozen null-prototype records. Capture record/reflection functions before guest entry, and use null-prototype arguments for observer intrinsic calls. Keep own loaded/exports state and original engine-supplied filename, with no guest hook or normal body wrapper. Consumer request identity is copied/frozen before entry; live KernelVirtualFS manifest identity and writable contents remain known limits, while actual evaluation selection is private. Production compilation only; paused inspector response and actual vendor loader remain unqualified.
