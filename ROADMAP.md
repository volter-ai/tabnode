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

Status: active; the realm-per-process migration is under way (its scaffolding released in v0.5.0)

Substrate constitution Articles 6 and 8. VS Code and its extensions receive their own asynchronous failures through Node's process
handlers, stderr and exit behavior. Ownership recorded at the identifier-constructor seam misses static,
chained, member-construction and native async promises, and restoring a broadcast would deliver unrelated
failures to every process. The owner-approved correction (substrate ADR-0037) gives each Node process, children
included, its own native JavaScript realm, reusing the substrate's worker and filesystem bridges, with World
authorization outside the guest. Process routing and the synchronous channel are connected; what the migration
still owes:
- descriptor inheritance across realms: an inherited socket reaches the native open (the child's
  `guessHandleType` reads only local tables today), listening-server transfer, and the V8 serializer gap;
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

## node-as-source: The engine behaves as Node, measured by Node's own suites

Status: active
Node's own fixtures drive the measurement (`scripts/node-tests.mjs`):
each module's current number is in `BUILTINS.md`. Each fix closes a class (what Node answers, deprecated or not), never a
fixture.
Completion:
- Node's `test/wasi` suite and its `test/parallel/test-child-process-*` tests pass in the engine, with every remaining failure recorded as an evidenced platform constraint.

## synchronous-children: Signals, timeouts and buffer limits for synchronous children

Status: planned
A synchronous child runs on a thread while the caller blocks on shared memory; `timeout` and `killSignal`
are ignored, and `maxBuffer` is reported after exit (ENOBUFS) rather than enforced, because there is no
process to kill; the browser path is written but unproven.
Completion:
- `spawnSync` and `execSync` honour `timeout`, `killSignal` and `maxBuffer` as Node does, proven on Node's fixtures in the tab.
