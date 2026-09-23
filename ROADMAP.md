# tabnode roadmap (Volter's fork)

## virtual-http-flow-control: Qualify negotiated streaming and cancellation

Status: source candidate; paired substrate integration and browser proof pending

Browser-substrate ADR-0030 requires unchanged guest HTTP clients to retain
streaming backpressure and disconnect propagation through the service worker.
The existing source pushed chunks without credit and dropped cancellation.
The candidate negotiates flowControl:1 only over the Host channel for explicit
ports, uses a zero-high-water-mark stream and one 64 KiB chunk credit, bounds
their uploads and keeps a finite header wait. Legacy ports retain their wire.

Completion:
- Paired substrate W63 bridge consumes the same credit/cancel protocol and
  proves bounds, errors, abort, teardown and reinitialization through its doors.
- An actual browser guest completes unchanged HTTP SDK requests, slow reading,
  cancellation and clean reopen; source/protocol fixtures alone are not done.
- After independent review and explicit release authority, publish an exact
  engine version and move the substrate pin; never patch installed dist files.

Open work on tabnode, Volter's fork of `macaly/almostnode`, Node in the browser patched toward Node as source. One
`## <id>: <title>` section each, with `Status:` and the `Completion:` lines that define done. The
measure is Node's own suites run against `dist/index.mjs` by `scripts/node-tests.mjs`
(`scripts/NODE-TESTS.md`); `BUILTINS.md` carries each module's number and what each remainder
is made of. The consumer is `volter-ai/browser-substrate`, which pins the engine by version and whose
changelog records what each version changed in the tab. What shipped is in
[`CHANGELOG.md`](CHANGELOG.md), one section per release; the fork's rules are
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`RELEASING.md`](RELEASING.md).

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
