# tabnode roadmap (Volter's fork)

Open work on tabnode, Volter's fork of `macaly/almostnode`, Node in the browser patched toward Node as source. One
`## <id>: <title>` section each, with `Status:` and the `Completion:` lines that define done. The
measure is Node's own suites run against `dist/index.mjs` by `scripts/node-tests.mjs`
(`scripts/NODE-TESTS.md`); `BUILTINS.md` carries each module's number and what each remainder
is made of. The consumer is `volter-ai/browser-substrate`, which pins the engine by version and whose
changelog records what each version changed in the tab. What shipped is in
[`CHANGELOG.md`](CHANGELOG.md), one section per release; the fork's rules are
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`RELEASING.md`](RELEASING.md).

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
