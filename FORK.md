# Volter's fork of tabnode

This is `volter-ai/tabnode`, forked from `macaly/almostnode` at package
version 0.2.14; this repository's history is its own. It is the Node
engine of the browser substrate, and it is patched toward Node here, as
source, and nowhere else: the substrate's shell carries no text patch of
the engine's build.

## Rules

- A change is a commit with the reason at the site: which program died,
  what Node does, what the engine did. The commit body carries the same.
- A change goes toward Node. Node's behavior is the reference, Node's own
  tests are the measure (`scripts/node-tests.mjs` runs them against
  `dist/index.mjs`; `scripts/NODE-TESTS.md`). A hand-written module
  that has grown a patch group is replaced with Node's own file from
  `nodejs/node/lib` on a binding written once; the measure goes up and the
  patches go away.
- Upstream's history is not this repository's. A change taken from upstream
  arrives as a patch with the reason at the site, like any other change.
- `dist/` is not tracked on `main`. The `release` branch carries built
  `dist/`, tagged `v0.2.14-volter.<n>`, and the package `@volter/tabnode` is
  published to npm from that commit at the same version; `npm run build:lib`
  writes the build. A release is a merge of `main` into `release`, the
  version in `package.json` and `package-lock.json` set to the release's
  own number, a build, a commit of `dist/`, a tag, and `npm publish`
  (`scripts/release-volter.sh <n>` does all of it). The version is not
  optional: the substrate reads the installed engine's version against its
  pin and refuses a mismatch, and releases .76 through .82 were cut still
  declaring .75, so every one of them was refused on a fresh install until
  .83 carried its number.
- **Stage a release's `dist/` with `git add -A -f dist`.** `dist/` is ignored
  on `main` and tracked on `release`, so a file the build NAMES BY CONTENT
  HASH -- `dist/assets/runtime-worker-<hash>.js` -- is a new, ignored path
  every time the worker's source changes: a plain `git add dist` stages the
  old asset's deletion and not the new one's addition, and the tag ships an
  engine whose worker is missing. The `-f` is what picks it up, and `-A` is
  what carries the deletion with it. Scope it to `dist` -- never `git add -A`
  at the root, where `node_modules` is a symlink. Caught cutting .48, the
  first release since .44 in which the worker's content changed.
- **Run `npm run build:lib` again after cutting a release, before trusting a
  test number.** `dist/` is ignored on `main` and tracked on `release`, so
  switching back to `main` at the end of a release deletes it, and the tests
  that spawn a real node over `dist/index.mjs` then fail for no reason at all.
  On 2026-09-16 that read as 31 failures where the baseline is 17, and a
  rebuild alone took it back to 17. The same rule holds whenever a measurement
  and a build straddle a commit: say which build each number came from.

## The measure

Each module replaced with Node's own file, and Node's own tests before and
after. The build each number came from is the one in the same row's commit.

| Module | Node's tests | Before | After | Vendored from | What still fails |
|---|---|---|---|---|---|
| `net` | `test-net-*` (151) | 63 | 99 | v22.18.0 | 52: a third are the harness's rather than the engine's (`internal/test/binding`, `node:test`, `process.send`, `process.getuid`, `--expose-internals`); the rest are the binding's synchronous writes, which queue nothing, so `bufferSize`, `bytesWritten` mid-write, `drain` and cork batching read 0, and the `autoSelectFamily` timing tests, which need a second address family to race. |
| `events` | `test-events-*` (9) | 0 | 2 | v22.18.0 | 7: four are the harness's (`--expose-internals` for `internal/event_target`, `node:test`); two need an `EventTarget` whose listeners can be enumerated, which the DOM does not allow -- `getEventListeners` of a realm target reports none; one reads a stack shape. |
| `util` | `test-util-*` (27) | 3 | 10 | v22.18.0 | 17: six are the harness's (`internal/util`, `internal/test/binding`, `node:test`); three are the named losses above (a proxy's target, a promise's state, a severed prototype's constructor); one wants an ES module namespace object, which the engine's lowering does not make; the rest are `inspect` details. |
| `http` / `https` | `test-http-*` (377) | 28 | 308 | v22.18.0 on llhttp's own wasm build (undici's, vendored in `src/node-lib/binding/llhttp-wasm.ts` with its sha256) | The `--expose-internals` harness tests; llhttp's own version differs from the one Node 22.18 links, so two error codes read as that build names them; `http2` is not ported. |
| `fs` / `fs/promises` | `test-fs-*` (246) | 52 | 126 | v22.18.0 | 120: a third are the harness's (`--expose-internals`, `node:test`, `process.getuid`); the rest are a tree with no kernel behind it -- no uid or gid, no permission bits to refuse a read, and link and symlink answer EPERM -- and the tests that measure exactly those. |
| the small modules | each module's own `test-<name>-*` | `assert` 2 of 16, `querystring` 0 of 3, `readline` 2 of 20, `diagnostics_channel` 25 of 46, `os` 0 of 6, `tty` 2 of 3, `punycode` and `constants` no tests | 4, 3 of 3, 10, 39, 0, 2 | v22.18.0 | `os`'s six are blocked by the harness's own stack-frame reading, not by `os`. Four modules were looked at and left as the engine's, each for a reason: `domain` and `async_hooks` are consumers of the async-hooks machinery the engine does not have, so Node's files load and then catch or track nothing; `timers` is Node's timer wheel over libuv's loop, where the engine's timers are the realm's per run; `string_decoder` and `url` need a stateful C++ binding (a decoder's carry-over, the URL parser), and the realm's `TextDecoder` and `URL` do not answer those contracts. |
| `zlib` | `test-zlib-*` (59) | 7 | 23 | v22.18.0 on zlib's own inflate and deflate, as pako 2.1.0 ports them (`pako/lib/zlib/*`, already the engine's dependency) | NOT a wasm build, and measured rather than assumed: pako's PUBLIC `Inflate`/`Deflate` cannot answer Node's contract -- given the caller's output buffer they write into it and then, the instant it fills, REPLACE it with one of their own and consume the rest into buffers the caller never sees, leaving no per-call `avail_in` to re-enter with. `pako/lib/zlib/*` is the layer below that loop: zlib's `inflate.c` and `deflate.c` ported line for line, taking a `z_stream` and honouring `next_out`/`avail_out` exactly as the C does, which is the interface Node's own C++ binding sits on. A zlib wasm build would have mirrored llhttp's lane and there is none to vendor: none exists anywhere on this box, npm's `zlib-wasm` is one maintainer, two versions and depends on pako itself, and compiling `deps/zlib` would mean running a C toolchain, which this product does not do. Of the 36 that still fail, 11 are Brotli and Zstd -- separate codecs with their own bindings, not ported -- and 8 are the harness's `node:test`. |
| `module`'s hooks | `test-module-hooks-*` (38, `--dir test/module-hooks`) | 0 | 34 | v22.18.0 (`internal/modules/customization_hooks.js`; `module.register`'s own chain is the engine's, for the reason `src/node-lib/module-hooks.ts` gives) | 4, none of them the chain: two require builtins the engine does not have (`node:sea`, `node:sqlite`, `node:test`, `node:test/reporters`); one has a load hook answer with a WebAssembly module, a format the engine's loader does not compile; one spawns `node --require <hooks> <file.cts>` with `--experimental-strip-types`, a command line the engine's `node` does not take. |

**A NUMBER MEASURED BEFORE v0.2.14-volter.49 COUNTED SOME TESTS THAT WERE
FAILING.** The engine's hand-written `EventEmitter` wrapped every listener
call in `try { … } catch (err) { console.error('Error in event listener:',
err); }`. A test whose assertion failed inside a listener -- which is where
most of Node's asynchronous tests assert -- printed that line and exited 0,
and this harness counts exit 0 as a pass. Replacing `events` with Node's own
file, where a throw from a listener is an uncaught exception as it is in Node,
made those failures visible: `child_process` reads 63 of 109 on .49 where it
read 75 on .48, and all thirteen of the difference exit 0 on .48 while
printing between one and ten swallowed errors each. The rows below are the
honest numbers; a row measured before .49 is an upper bound, not a
measurement. This is also the more important defect the lane found: until
.49, a guest's event handler could throw in the tab and nothing would stop,
report or fail.

Where the evidence stops: the row above measures `module.registerHooks`,
whose chain is the vendored file. Node's own suite has no in-process test of
`module.register` -- all six of its `test/es-module` tests that call it spawn
a Node with `--loader`, `--input-type` and `--eval`, so they measure a command
line rather than the API. The asynchronous half is measured instead on the
shape that asked for it: the extension host's own hook module and register
call, transcribed out of openvscode-server 1.109.5, run through the engine.

## Layout

The engine's source is `src/`, and it is all engine: `runtime.ts` is the
module loader, the module table and the `node` program; `node-lib/` is Node's
own library over `node-lib/binding/`; `shims/` is what the engine answers
itself, where Node's own is native (`BUILTINS.md`, Kind 2), plus the engine's
process model and the bundler doors; `npm/` is the installer; `worker/` is the
worker entry. Upstream's demos, site, sandbox, end-to-end suite and
hand-written framework dev servers were deleted in `v0.2.14-volter.85`.
