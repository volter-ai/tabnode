# Changelog

What each release changed, newest first. A release is a tag `v<version>` on `main` and the npm package `@volter/tabnode` at the same version, published from the tag by the `publish` workflow. Through `v0.2.14-volter.88` the version counted up from upstream's; from `v0.3.0` it is the fork's own semver line. `volter-ai/browser-substrate` pins one version and its changelog records what that version changed in the tab. Upstream's own history, before the fork, is at the end.

## v0.4.0 — 2026-09-21

The host run options add streamed input and terminal control; virtual filesystem
metadata methods become part of the exported filesystem surface.

- Pass a run's streamed stdin and terminal dimensions through to its guest,
  deliver resize events, release producer/subscription resources on exit and
  report interrupted runs as 143. Substrate `verify:process-contract` measures
  the host-facing behavior; `verify:node-adapters` covers dormant input cleanup.
- Count filesystem watches as active handles, retain unreferenced handles for
  exit cleanup, and execute watch notifications in their owning run. Substrate
  `verify:node-filesystem-policy` exercises holder edits and unreferenced watches.
- Delegate writable-open checks and metadata mutations to the filesystem view.
  Modes belong to nodes rather than a global path table; zero modes, rename,
  timestamps and existing-directory mkdir follow Node's behavior. Unsupported
  ownership changes report ENOTSUP instead of pretending to mutate ownership.
  Substrate `verify:node-adapters` and `verify:node-filesystem-policy` are the
  reproductions; these are host measurements, not browser acceptance.

- Release a guest server's bridge registration when its listener closes, including
  process cancellation. Guest entries now carry request adapters instead of null;
  identify those adapters without removing a host replacement on the same port.
  Substrate `verify:port-contract` and all 79 adapter checks pass against this source
  build. This is a host measurement, not browser acceptance.

## v0.3.1 — 2026-09-21

- Restore filesystem descriptor semantics used by the substrate's lock-file gate:
  UTF-8 reads and writes accept an open descriptor and honor its position and access
  mode; path writes use the same open flags as buffer writes, refuse missing parents,
  and close rejects an invalid descriptor. In-memory nodes have distinct inode numbers
  that survive writes and renames. The substrate's 79 adapter checks pass against this
  source-built candidate; this is a host measurement, not browser acceptance.

## v0.3.0 — 2026-09-21

The version is the fork's own: `0.3.0`, semver from here, in place of a counter over upstream's `0.2.14`. A release is a tag on `main`; the `release` branch and the committed `dist/` are gone, and the `publish` workflow builds the tag, publishes `@volter/tabnode` with npm provenance, and makes the GitHub release. The workflow holds the one publish token, as the repository's secret, until npm's trusted publisher for it is confirmed (`RELEASING.md`); then none exists anywhere.

The package is ES modules only, with no CommonJS build and no source maps: 11 MB unpacked where `.88` was 29. `src/` still ships, since a host that bundles the engine from source reaches `src/shims/*.ts` through it. `engines.node` is 20.19, the first Node whose `require()` loads an ES module.

The `measure` workflow runs the build, the type-check, the engine's own checks and Node's own suite module by module on every push to `main`, and prints the numbers in its job summary. It blocks nothing.

`docs/api/` is the exported surface, generated from the declarations by TypeDoc at each release. `FORK.md`, which held the rules until now, is dissolved: provenance is the README's "About this fork", the release procedure is `RELEASING.md`, and what each module's remainder is made of is in its row of `BUILTINS.md`. `CODE_OF_CONDUCT.md` is the Contributor Covenant 2.1. Issue and pull request templates ask for the triple a change is stated in: which program died, what Node does, what the engine did.


## v0.2.14-volter.88 — 2026-09-21

The package is `@volter/tabnode` on npm, published from the release commit at the release's version; `npm install @volter/tabnode` is the way in, and the `release` branch still carries the same build for an install by git tag. The release script publishes after it pushes the tag.

## v0.2.14-volter.87 — 2026-09-21

The engine names no package. `src/tailwind-vite-stand-in.ts` carried a table, `@tailwindcss/vite` to a file of the tab's, that the loader and the bundler's resolver read; both now read the host's table (`globalThis.__browserRuntimeStandInPaths`, package name to file), which the module resolver already read, and the file is gone. What a guest gets is unchanged where the host names the same table, which the substrate does.

Node's own suite is run from here: `scripts/node-tests.mjs` runs files of Node's test tree as programs of a build and counts the ones that exit 0, `dist/index.mjs` unless `--engine` names another; `scripts/NODE-TESTS.md` says where the tree comes from and what `scripts/diagnostic-prelude.cjs` is for.

`npm run type-check` is clean over `tests/`, which had 190 errors: `createFsShim` is typed as Node's `fs`, which is what it returns; the test of the deleted hand-written `Dirent` class is gone; the rest were casts.

## v0.2.14-volter.86 — 2026-09-21

The repository's history begins here: `main` is one commit holding the tree, and `release` and this tag are cut from it.

Provenance the tree carries is now written where a reader looks for it: `LICENSE` keeps upstream's copyright notice beside this fork's, Node's own licence sits at `src/node-lib/LICENSE` beside the files it covers, and `THIRD-PARTY-NOTICES.md` names what else is carried from elsewhere (llhttp's wasm build, punycode). The package ships that file.

What the deleted dev servers had left in `src/code-transforms.ts` is gone with them: the CSS-module rewrites over `css-tree`, the esm.sh import redirect that recognised `next/*` and pinned React to a CDN, and the React Refresh wrapper. What remains is the ESM lowering the runtime uses, and `css-tree` is no longer a dependency. `public/vite-sw.js`, the deleted Vite dev server's service worker, no longer ships in `dist/`.

`npm test` runs the engine's own checks; the script had gone with upstream's. `process.eventNames()` is typed as Node types it, `(string | symbol)[]`, which were the source tree's two type errors.

## v0.2.14-volter.85 — 2026-09-21

The repository is the engine and nothing else. Upstream's product, which the engine had carried unreachable beside itself, is deleted: the landing site and the docs site, the seven demo pages and their entries, the hand-written Next and Vite dev servers (`src/frameworks/`, about seven thousand lines), the cross-origin sandbox runtime with its page, its build and its helpers, the end-to-end suite, the three GitHub workflows, the container recipe, the branding, and the PM apparatus (`hermes/`, `.open-autonomy/`). `src/code-transforms.ts`, the ESM lowering the runtime uses, is what came out of `src/frameworks/` alive.

Eight hand-written builtins `BUILTINS.md` had already recorded as deleted were still in `src/shims/`, imported by `runtime.ts` and served to no one: `assert`, `querystring`, `readline`, `tty`, `chokidar`, `readdirp`, `fsevents` and `diagnostics_channel`. They are deleted, and the record now says what is true.

One of those was not inert. `watchChildren` subscribed to the `child_process` diagnostics channel on the imitation's registry, while Node's own `internal/child_process.js` publishes on the vendored module's: two registries, so the subscriber heard nothing, no child was recorded, and `process.kill(pid, 0)` answered ESRCH for a live child. The subscriber is on Node's own module now.

`createRuntime` no longer takes `sandbox` or `dangerouslyAllowSameOrigin`: it puts a guest on the caller's thread or on a worker, and origin isolation is the embedder's to place, which in the tab is the substrate's isolation worker. The package publishes `.` and `./vite`; `./next`, which served a service worker from a Next route, is gone. The dependencies only the demos used (`ai`, `@ai-sdk/*`, `zod`, `xterm`, playwright, jsdom) are gone with them.

The bundle is 3,090,499 bytes, down from 3,318,662.

## v0.2.14-volter.84 — 2026-09-21

The engine is tabnode: the package and the repository carry the name that says what the tree is. `FORK.md` records that a release sets its own version, since .76 through .82 declared .75 and the substrate refused them.

## v0.2.14-volter.83 — 2026-09-21

The version the release declares is its own. Same source as .82.

## v0.2.14-volter.82 — 2026-09-21

- `buffer.toString(encoding)` takes the encoding as a string the binding has already checked.

## v0.2.14-volter.81 — 2026-09-21

- The container answers a process's pid and its parent's.
- A handled uncaught exception that calls `process.exit(1)` still prints its receipt.
- `readdir` with `encoding: 'buffer'` answers Buffer names.
- A builtin's ESM namespace is the module's own keys.

## v0.2.14-volter.80 — 2026-09-21

- A second process's `fs` is compiled from the fs module, not from the runtime, so two runtimes in one realm keep their own trees.

## v0.2.14-volter.79 — 2026-09-21

- The `node` command reads the run's tree without importing the fs binding.

## v0.2.14-volter.78 — 2026-09-21

- Two runtimes in one realm keep their own trees.

## v0.2.14-volter.77 — 2026-09-21

- A spawn's piped stdin reaches a host-registered program.

## v0.2.14-volter.76 — 2026-09-21

- A probe left in `process.cwd()` is removed.

## v0.2.14-volter.75 — 2026-09-21

- A child's `process.send` on a closed channel is `ERR_IPC_CHANNEL_CLOSED`.
- The extension host, forked as the server forks it, sends `ready`.

## v0.2.14-volter.74 — 2026-09-21

- A descriptor opened for reading holds the file from its first read.

## v0.2.14-volter.73 — 2026-09-21

Same source as .72, rebuilt.

## v0.2.14-volter.72 — 2026-09-21

- The constants binding builds its crypto and zlib groups from literals, read at use rather than at load.
- `util.inspect` of an Error answers `BuiltinModule.exists`, and a pipe is not a TTY.

## v0.2.14-volter.71 — 2026-09-21

- A piped run that dies names itself on the host console.

## v0.2.14-volter.70 — 2026-09-21

- A write takes a Buffer's named bytes, not its pool.
- The callback flavour of an fs answer invokes `oncomplete` as a method of the request.

## v0.2.14-volter.69 — 2026-09-20

- The loopback client ends a response at the message, not the socket.
- The fs binding resolves a relative path against the calling run's cwd.

## v0.2.14-volter.68 — 2026-09-20

- Vendored files reach the engine's shims; `fs` answers `chmod`, links and blobs.
- The callback flavour of an fs answer captures `oncomplete` on the calling stack.

## v0.2.14-volter.67 — 2026-09-20

- A guest `listen` registers a server the page can observe.
- The fs binding carries the run's tree from the call into the tick.

## v0.2.14-volter.66 — 2026-09-20

- A release's version is its tag: `package.json` carries `0.2.14-volter.N` from here, so an installed engine can be told from another.
- A socket handed from a guest server to its forked child holds for the page, and again after a reconnect.

## v0.2.14-volter.65 — 2026-09-20

- A `require` goes through `Module._load`, so a program that replaces it is asked.
- Every process has its own number, and a number nobody runs is `ESRCH`.

## v0.2.14-volter.64 — 2026-09-20

- Every process has its own number, and a number nobody runs is `ESRCH`.

## v0.2.14-volter.63 — 2026-09-20

- A module object is a program's to write on: `require('fs')` takes a `defineProperty`.

## v0.2.14-volter.62 — 2026-09-20

- The fs binding answers Node's promise flavour, so `fs.promises` works.

## v0.2.14-volter.61 — 2026-09-20

- `require('timers')` answers Node's `Timeout`, and is called on the realm.

## v0.2.14-volter.60 — 2026-09-20

- A vendored file compiled where the realm has no `process` reads Node's own facts.

## v0.2.14-volter.59 — 2026-09-20

- Brotli and Zstandard refuse by name, rather than by a missing constructor.

## v0.2.14-volter.58 — 2026-09-20

- `zlib` is Node's own `zlib.js` on zlib's own inflate and deflate, as pako ports them: 23 of 59 of Node's tests, where the imitation's number was 7.

## v0.2.14-volter.57 — 2026-09-20

- `assert`, `querystring`, `readline`, `diagnostics_channel`, `os`, `tty`, `punycode` and `constants` are Node's own files, and the fs imitation is gone.

## v0.2.14-volter.56 — 2026-09-20

- `fs` is Node's own `fs.js` on a binding over the virtual filesystem: 126 of 246 of Node's tests, where the imitation's number was 52.

## v0.2.14-volter.55 — 2026-09-20

- A bridge answer's body is bytes, and may be absent.

## v0.2.14-volter.54 — 2026-09-20

- A bridge answer's header may carry several values, as Node's `getHeaders()` answers; the fetch answer's headers are their own, beside the request's.

## v0.2.14-volter.53 — 2026-09-20

- A bridge answer's status message is optional, as Node's `res.statusMessage` is.

## v0.2.14-volter.52 — 2026-09-20

- The bridge streams a guest server's answer to a host caller, and a server's address may be a path.

## v0.2.14-volter.51 — 2026-09-20

- `http` and `https` are Node's own files on llhttp's wasm build: 308 of 377 of Node's tests, where the imitation's number was 28.
- The page's requests are bytes on a socket, and `ws` is the real package, installed by the project.

## v0.2.14-volter.50 — 2026-09-20

- `util`'s lazy exports reach the loader, not a realm that has no `require`.

## v0.2.14-volter.49 — 2026-09-20

- `events` and `util` are Node's own `events.js` and `util.js`. The hand-written `EventEmitter` had caught every listener's throw and printed it, so a test that failed inside a listener exited 0; the measure counted those, and now it does not. Every number measured before this release is an upper bound.
- A run with a module resolution outstanding is not idle.
- A name that stands for a class is a class a program can extend.
- A release stages its `dist/` with `git add -A -f dist`, or the tag ships no worker.

## v0.2.14-volter.48 — 2026-09-20

- `module.registerHooks` is Node's own file, one instance per run: 34 of 38 of Node's tests, where there was no `register` at all. A require and a load ask the chain where Node asks it, and Node names every builtin a process has loaded.

## v0.2.14-volter.47 — 2026-09-20

- The engine's index exports `buffer`, where Node keeps `Buffer`.

## v0.2.14-volter.46 — 2026-09-20

- `buffer` and `stream` are Node's own `buffer.js` and `stream.js`: 47 of 64 and 146 of 171 of Node's tests, where the imitations' numbers were 15 and 70.
- A stream the engine fills still answers Node's `_read`; a copy's length and the base64 alphabet are Node's; a child that exits with its channel open is reported.
- A `defineProperty` the host refuses lands on the guest global.

## v0.2.14-volter.45 — 2026-09-20

- `net` and `child_process` are Node's own `net.js` and `child_process.js` on a libuv-shaped binding written once, with the internals they name vendored or bound: 99 of 151 and 75 of 109 of Node's tests, where the hand-written modules' numbers were 63 and 52. A vendored file loads as Node's `BuiltinModule` loads it.
- A sent descriptor crosses as a duplicate, beside the bytes of its message; a write is read before the end that followed it, and a stream at EOF is done.
- `BUILTINS.md` names every builtin's kind and reason, and its number against Node's own tests.

## v0.2.14-volter.44 — 2026-09-20

- A module evaluates under its own name and line numbers, as Node's wrapper keeps them.

## v0.2.14-volter.43 — 2026-09-20

- The socket an upgrade listener is handed is a `net.Socket`, framed or not.
- `net.Socket` reports `bufferSize` and `writableLength`, as Node's does.

## v0.2.14-volter.42 — 2026-09-20

- An IPC send carries its handle, and the process that receives a socket owns it.

## v0.2.14-volter.41 — 2026-09-20

- `fork` resolves its module path as `require` does.
- `kill` on a child that has exited does nothing, and `exit` fires once.

## v0.2.14-volter.40 — 2026-09-20

- A program that has ended holds no timers, as an ended Node process holds none.
- An open socket keeps its run alive, as a handle keeps Node's loop alive.
- An exception a timer callback throws is its process's uncaught exception, never the host's.
- `unhandledRejection` is emitted with its promise, as Node emits it.

## v0.2.14-volter.39 — 2026-09-20

- A byte-pipe upgrade is asked for by the connect message's own field, not by a flag of one program.

## v0.2.14-volter.38 — 2026-09-20

- `http`'s upgrade hands the listener a real socket, and a server that answers the handshake itself is heard.

## v0.2.14-volter.37 — 2026-09-20

- A chunked decode says what a whole-buffer decode says, and `Readable.setEncoding` decodes over a `StringDecoder` that is Node's.
- `util.getCallSites` reports the frames above its caller.
- `crypto.randomBytes` calls back, and `randomFill` exists.
- `net` listens on and connects to a unix-socket path.
- The release script pushes the branch before the tag, and each push can fail on its own.

## v0.2.14-volter.36 — 2026-09-20

- `Buffer.isBuffer` is true for a Buffer and for nothing else.
- A run that owns a listening server is not idle, as an open handle keeps Node's loop alive.

## v0.2.14-volter.35 — 2026-09-18

- A run that owns a listening server keeps running, as an open handle keeps Node's loop alive; such a run was cut at the idle boundary half a second after its last output, and a guest's `vite` child lost its server.

## v0.2.14-volter.34 — 2026-09-18

- The container's `sendInput` takes the run's process token, so a host delivers a keystroke to the run a person is typing to.

## v0.2.14-volter.33 — 2026-09-18

- The current process token is the run whose guest code is executing, carried by the engine's own async-local storage, and the container answers it; a child spawned from a second run is attributed to its own parent.

## v0.2.14-volter.32 — 2026-09-18

- `process.argv[0]` is the executable's path, as Node fills it; the bridge's spawned argument list is what a host runs, so an argument with a quote in it survives.

## v0.2.14-volter.31 — 2026-09-18

- A run's streaming callbacks, signal and stdin belong to that run, keyed by its process token, and a run is long-running only when the host holds it (`held`); a child spawned by a guest no longer inherits its parent's hold or captures its output.

## v0.2.14-volter.30 — 2026-09-17

- A run that ends releases its servers, however it ended; only an explicit `process.exit` had.

## v0.2.14-volter.29 — 2026-09-17

- `import()` coerces its specifier to a string as Node does; ESLint's formatter loader imports a `file:` URL object.

## v0.2.14-volter.25 — 2026-09-16

- `process.constrainedMemory` and `availableMemory`, which Node answers and a driver asks; dist is rebuilt after a release so the suite cannot lie.

## v0.2.14-volter.24 — 2026-09-16

- A synchronous child that cannot start answers and never waits; the upgrade channel is the server bridge's to hold and give back; standard input is a readable stream; the five stream constructors are functions.

## v0.2.14-volter.23 — 2026-09-16

- One list of Node's builtins for both dynamic-import lowerings; `process.binding`, which Node deprecated and still answers.

## v0.2.14-volter.22 — 2026-09-16

- A synchronous child (`spawnSync`, `execSync`) runs to its end before the call returns; what Node's own test helper reads from `process` and `net` before any test runs.

## v0.2.14-volter.21 — 2026-09-16

- A host that imports the engine keeps its own realm, as a library leaves one.

## v0.2.14-volter.20 — 2026-09-16

- `util._extend`, which Node deprecated and still exports.

## v0.2.14-volter.19 — 2026-09-16

- A request keeps the headers it was built with, as Node keeps them.

## v0.2.14-volter.18 — 2026-09-16

- A request reaching a guest's server carries a Host, as one from a socket does.

## v0.2.14-volter.17 — 2026-09-16

- Work the host is doing for a guest holds the guest's run.

## v0.2.14-volter.16 — 2026-09-16

- A run the host names is a process the engine can be asked about.

## v0.2.14-volter.15 — 2026-09-16

- `node:wasi`, Node's own lib on a binding over the engine's filesystem; the wasi, fs, assert and process defects an adversarial review found; an assert regular-expression validator is tested against the whole error.

## v0.2.14-volter.14 — 2026-09-16

- A directory that appears or goes is announced to a watcher of its parent.

## v0.2.14-volter.13 — 2026-09-15

- A CommonJS body is compiled sloppy, as Node compiles one.

## v0.2.14-volter.12 — 2026-09-15

- A run a host holds under a signal reports settled once nothing is held; an imported binding's read stands bare, parenthesized only as a `new` callee.

## v0.2.14-volter.11 — 2026-09-15

- `Module.prototype._compile` compiles a body in place through the engine's own loader; the `transformSync` thread starts when the host is installed and every wait is bounded.

## v0.2.14-volter.10 — 2026-09-15

- An unhandled rejection ends the program as Node ends one; a printed program runs until its loop is empty; `transformSync` answers before returning and `stop()` ends what it started.

## v0.2.14-volter.9 — 2026-09-15

- A lowered module body is a generator driven synchronously; `data:` URL modules; the worker after a restart; `Buffer` `indexOf`, `lastIndexOf` and `includes` take a string, a byte view or a number.

## v0.2.14-volter.8 — 2026-09-15

- The page names the primary server and its own frames to the service worker, and the bridge re-announces them; the preview's server answers at the origin's root.

## v0.2.14-volter.7 — 2026-09-15

- `util.parseEnv`; an upgrade listener is handed an `IncomingMessage`; a missing tsconfig base is a warning in the esbuild shim.

## v0.2.14-volter.6 — 2026-09-15

- The esbuild shim's neighbors filter is a Go regular expression.

## v0.2.14-volter.5 — 2026-09-15

- `require('path')` is Node's posix object itself; the binding's platform is the engine's.

## v0.2.14-volter.4 — 2026-09-15

- A silent program ends when its loop has nothing left; the node resolver is exported for a host that resolves as the engine does; path expectations are Node's.

## v0.2.14-volter.3 — 2026-09-15

- The exports Node keeps though deprecated: timers enroll/active/unenroll, fs access modes, `util.log`/`isSymbol`, `process.assert`, `assert.CallTracker`; a file run as it stands is not rewritten.

## v0.2.14-volter.2 — 2026-09-15

- A require of an ES module is its namespace; the npm resolver chooses the root's dependencies before any is walked; the default export is the exports' default name.

## v0.2.14-volter.1 — 2026-09-15

- The fork's baseline port, 146 commits: the fs shim and its descriptor table, net, http and ws, the worker_threads thread host, TypeScript resolution, symlinks, the npm resolver and lockfile pins, the stream surface, and `FORK.md` with the rules. The last change before the tag: the esbuild shim resolves a path as the file's own, and the `.mjs`-as-`.js` renaming that served an install-time rewrite is off.

## [0.2.14] - 2026-02-14

### Added
- **Agent Workbench demo**: AI coding agent that builds Next.js pages live with file editing, bash execution, and HMR preview. Added to homepage demos grid.
- **Vercel AI SDK demo**: Streaming AI chatbot with Next.js, OpenAI, and real-time token streaming via Pages Router API route
- **Express demo E2E tests**: New Playwright tests for the Express server demo
- **`vfs-require` module** (`src/frameworks/vfs-require.ts`): Shared require system extracted for reuse across entry points
- **`npm-serve` module** (`src/frameworks/npm-serve.ts`): Shared `/_npm/` package bundling endpoint with nested exports support
- **CI E2E pipeline**: GitHub Actions now runs Playwright E2E tests after unit tests with Chromium
- **CLAUDE.md**: Project instructions file for AI-assisted development

### Fixed
- **Route group client-side navigation**: Pages inside route groups (e.g. `(marketing)/about`) now render correctly during client-side navigation. Replaced local path construction with server-based `resolveRoute()` using extended `/_next/route-info` endpoint that returns actual `page` and `layouts` paths.
- **`convertToModelMessages` import**: Vercel AI SDK demo now imports from `ai` package instead of non-existent `@ai-sdk/ui-utils`
- **npm-serve nested exports**: Packages with nested `exports` field entries (e.g. `ai/react`, `@ai-sdk/openai`) now resolve correctly
- **TypeScript type errors**: Fixed duplicate `setEnv` method, `executeApiHandler` return type, `cpExec` callback types

### Changed
- **Agent Workbench guardrails removed**: AI agent can now modify any project file including root page (`/app/page.tsx`), `package.json`, and `tsconfig.json`. Only `/pages/api/chat.ts` remains protected.
- **E2E tests hardened**: Removed try/catch fallbacks across all E2E tests for strict assertions; collect page errors for better debugging
- **Convex and Vite demos refactored**: Use platform's `vfs-require` and `npm-serve` modules instead of inline implementations

## [0.2.13] - 2026-02-12

### Added
- **Centralized CDN configuration** (`src/config/cdn.ts`): Single source of truth for esm.sh, unpkg, and other CDN URLs used across the codebase
- **esm.sh version resolution**: `redirectNpmImports` now reads `package.json` dependencies and includes the major version in esm.sh URLs (e.g. `ai@4/react`), fixing 404s on subpath imports
- **Setup overlay dialogs**: Convex and Vercel AI SDK demos now show an API key setup dialog on load with privacy notice ("your key stays in your browser")
- **New tests**: `tests/cdn-config.test.ts` (12 tests) and `tests/code-transforms.test.ts` (11 tests)

### Changed
- Renamed AI chatbot demo files: `demo-ai-chatbot.html` → `demo-vercel-ai-sdk.html`, `ai-chatbot-demo.ts` → `vercel-ai-sdk-demo.ts`
- Replaced hardcoded CDN URLs throughout codebase with imports from `src/config/cdn.ts`

### Removed
- **`sentry` shim** (`src/shims/sentry.ts`): Was a no-op stub for a non-existent Node.js built-in
- **Custom `convex` command** in `child_process.ts`: Convex now runs through the generic bin stub system like any other CLI tool
- **Convex-specific path remaps** in `fs.ts`: `path.resolve()` with correct `cwd` handles this generically
- **`vfs:` prefix stripping** in `fs.ts`: Moved to esbuild shim where the artifact originates

## [0.2.12] - 2026-02-12

### Added

- **Generic bin stubs:** `npm install` now reads each package's `bin` field and creates executable scripts in `/node_modules/.bin/`. CLI tools like `vitest`, `eslint`, `tsc`, etc. work automatically via the `node` command — no custom commands needed.
- **Streaming `container.run()` API:** Long-running commands support `onStdout`/`onStderr` callbacks and `AbortController` signal for cancellation.
- **`container.sendInput()`:** Send stdin data to running processes (emits both `data` and `keypress` events for readline compatibility).
- **Vitest demo with xterm.js:** New `examples/vitest-demo.html` showcasing real vitest execution in the browser with watch mode, syntax-highlighted terminal output, and file editing.
- **E2E tests for vitest demo:** 5 Playwright tests covering install, test execution, tab switching, failure detection, and watch mode restart.
- **`rollup` shim:** Stub module so vitest's dependency chain resolves without errors.
- **`fs.realpathSync.native`:** Added as alias for `realpathSync` (used by vitest internals).
- **`fs.createReadStream` / `fs.createWriteStream`:** Basic implementations using VirtualFS.
- **`path.delimiter` and `path.win32`:** Added missing path module properties.
- **`process.getuid()`, `process.getgid()`, `process.umask()`:** Added missing process methods used by npm packages.
- **`util.deprecate()`:** Returns the original function with a no-op deprecation warning.

### Changed

- **`Object.defineProperty` patch on `globalThis`:** Forces `configurable: true` for properties defined on `globalThis`, so libraries that define non-configurable globals (like vitest's `__vitest_index__`) can be re-run without errors.
- **VFS adapter executable mode:** Files in `/node_modules/.bin/` now return `0o755` mode so just-bash treats them as executable.
- **`Runtime.clearCache()` clears in-place:** Previously created a new empty object, leaving closures referencing the stale cache. Now deletes keys in-place.
- **Watch mode uses restart pattern:** Vitest caches modules internally (Vite's ModuleRunner), so file changes require a full vitest restart (abort + re-launch) rather than stdin-triggered re-runs.

### Removed

- **Custom vitest command:** Deleted `src/shims/vitest-command.ts` and removed vitest-specific handling from `child_process.ts`. Vitest now runs through the generic bin stub + `node` command like any other CLI tool.

## [0.2.11] - 2026-02-09

### Fixed

- **Firefox blank preview:** Fixed Vite dev server injecting `<script type="module">` (React Refresh preamble) before `<script type="importmap">` in served HTML. Firefox strictly requires import maps to appear before any module scripts. The preamble is now injected after the last import map when one is present. ([#3](https://github.com/macaly/almostnode/issues/3))

## [0.2.10] - 2026-02-09

### Changed

- **Next.js dev server refactoring:** Extracted route resolution and API handler logic into standalone modules, reducing `next-dev-server.ts` from ~2240 to ~1360 lines (39% reduction):
  - `next-route-resolver.ts` (~600 lines) — App Router/Pages Router route resolution, dynamic routes, route groups, catch-all segments
  - `next-api-handler.ts` (~350 lines) — mock request/response objects, cookie parsing, API handler execution, streaming support
- **115 new unit tests** for the extracted modules (63 route resolver + 52 API handler)

## [0.2.9] - 2026-02-08

### Added

- **`browser` field support in module resolution:** npm packages with a `browser` field in package.json now resolve to their browser-specific entry point. Supports both string form (`"browser": "lib/browser/index.js"`) and object form (`"browser": {"./lib/node.js": "./lib/browser.js"}`). This fixes compatibility with packages like `depd`, `debug`, and others that provide browser-optimized versions.

### Fixed

- **Safari Express crash:** Fixed `callSite.getFileName is not a function` error when running Express in Safari. The `depd` package (an Express dependency) uses V8-specific `Error.captureStackTrace` APIs that don't exist in WebKit. By respecting depd's `"browser"` field, the no-op browser version is now loaded instead.
- **`Error.captureStackTrace` polyfill improvements:** Added `Error.stackTraceLimit` default, `.stack` getter interception on `Error.prototype` for lazy `prepareStackTrace` evaluation, re-entrancy protection, and error logging instead of silent fallback.

## [0.2.8] - 2026-02-07

### Added

- **Convex CLI deployment:** Full in-browser Convex deployment via the CLI bundle with 4 runtime patches (Sentry stub, crash capture, size check skip, site URL derivation)
- **Next.js dev server refactoring:** Extracted ~1700 lines into standalone modules:
  - `next-shims.ts` — shim string constants (~1050 lines)
  - `next-html-generator.ts` — HTML template generation (~600 lines)
  - `next-config-parser.ts` — AST-based config parsing with regex fallback (~140 lines)
  - `binary-encoding.ts` — base64/uint8 encoding utilities
- **HTTP shim improvements:** `IncomingMessage` now supports readable stream interface (`on('data')`, `on('end')`), chunked transfer encoding, proper content-length tracking
- **WebSocket shim:** Real WebSocket connectivity for Convex real-time sync (connect to `wss://` endpoints, binary frame support, ping/pong handling)
- **Stream shim:** Added `PassThrough` stream implementation
- **Crypto shim:** Added `timingSafeEqual` implementation
- **Convex E2E tests:** 6 Playwright tests including HTTP API verification that proves modified mutations deploy and run on the Convex backend

### Fixed

- **`path.resolve()` must use `process.cwd()`:** Was prepending `/` for relative paths instead of the actual working directory — caused Convex CLI to resolve `'convex'` → `/convex` instead of `/project/convex`
- **esbuild `absWorkingDir` must use `process.cwd()`:** Was defaulting to `/`, causing metafile paths to be relative to root instead of the project directory, resulting in doubled paths like `/project/project/...`
- **Convex `_generated` directory:** No longer deletes `/convex/_generated/` during deployment — the live Next.js app imports from it while the CLI only needs `/project/convex/_generated/`
- **`path.join()` debug logging removed:** Cleaned up leftover `console.log` calls for `_generated` path joins

## [0.2.7] - 2026-02-05

### Added

- **AST-based code transforms:** Replaced fragile regex-based transforms with proper AST parsing using `acorn` and `css-tree`
  - CSS Modules: `css-tree` AST for reliable class extraction and scoping (handles pseudo-selectors, nested rules, media queries)
  - ESM→CJS: `acorn` AST for precise import/export conversion (handles class exports, re-exports, `export *`, namespace imports)
  - React Refresh: `acorn` AST component detection — no longer false-detects `const API_URL = "..."` as a component
  - npm import redirect: `acorn` AST targets import/export source strings precisely, avoiding false matches in comments/strings
  - All transforms gracefully fall back to regex if AST parsing fails
- **Shared code-transforms module:** Extracted ~350 lines of transform logic into `src/frameworks/code-transforms.ts`, deduplicating `addReactRefresh()` between NextDevServer and ViteDevServer
- **New features:** CSS Modules, App Router API Routes, `useParams`, Route Groups, `basePath`, `loading.tsx`/`error.tsx`/`not-found.tsx` convention files, `next/font/local`
- **E2E test harness:** Added `examples/next-features-test.html` and `e2e/next-features.spec.ts` with 25 Playwright tests covering all new features

### Fixed

- **App Router API query params:** Fixed query string not being passed to App Router route handlers (`handleAppRouteHandler` now receives `urlObj.search`)
- **E2E import paths:** Fixed `examples/vite-demo.html` and `examples/sandbox-next-demo.html` using wrong relative import path (`./src/` → `../src/`)
- **E2E test assertions:** Fixed dynamic route test checking for `[id].jsx` string that never appears in generated HTML; fixed vite-error-overlay blocking clicks in navigation tests
- **Convex demo logging:** Added key file path logging so e2e tests can verify project files

### Dependencies

- Added `acorn` (8.15.0), `acorn-jsx` (5.3.2), `css-tree` (3.1.0)

## [0.2.6] - 2026-02-02

### Added

- **Asset prefix support:** NextDevServer now supports `assetPrefix` option for serving static assets with URL prefixes (e.g., `/marketing/images/...` → `/public/images/...`)
- **Auto-detection:** Automatically detects `assetPrefix` from `next.config.ts/js/mjs` files
- **Binary file support:** Macaly demo now supports base64-encoded binary files (images, fonts, etc.) in the virtual file system
- **File extraction script:** Added `scripts/extract-macaly-files.ts` to load real-world Next.js projects including binary assets

### Fixed

- **Virtual server asset routing:** Service worker now forwards ALL requests from virtual contexts (images, scripts, CSS) to the virtual server, not just navigation requests. This fixes 404 errors for assets using absolute URLs.
- **Double-slash URLs:** Handle URLs like `/marketing//images/foo.png` that result from concatenating assetPrefix with paths

## [0.2.5] - 2025-02-01

### Added

- **Transform caching:** Dev servers now cache transformed JSX/TS files with content-based invalidation, improving reload performance
- **Module resolution caching:** Runtime caches resolved module paths for faster repeated imports
- **Package.json parsing cache:** Parsed package.json files are cached to avoid repeated file reads
- **Processed code caching:** ESM-to-CJS transformed code is cached across module cache clears

### Fixed

- **Service Worker navigation:** Plain `<a href="/path">` links within virtual server context now correctly redirect to include the virtual prefix
- **Virtual FS mtime:** File system nodes now track actual modification times instead of returning current time
- **Flaky zlib test:** Fixed non-deterministic test that used random bytes

## [0.2.4] - 2025-01-31

### Fixed

- **App Router navigation:** Extended client-side navigation fix to also support App Router (`/app` directory). Both Pages Router and App Router now use dynamic imports for smooth navigation.

## [0.2.3] - 2025-01-31

### Fixed

- **Next.js Link navigation:** Fixed clicking `<Link>` components causing full iframe reload instead of smooth client-side navigation. Now uses dynamic page imports for proper SPA-like navigation.

## [0.2.2] - 2025-01-31

### Fixed

- **Critical:** Fixed browser bundle importing Node.js `url` module, which broke the library completely in browsers. The `sandbox-helpers.ts` now uses dynamic requires that only run in Node.js.

## [0.2.1] - 2025-01-31

### Fixed

- CI now builds library before running tests (fixes failing tests for service worker helpers)

### Changed

- Added security warning to Quick Start section in README
- Clarified that `createContainer()` should not be used with untrusted code
- Added "Running Untrusted Code Securely" example using `createRuntime()` with sandbox
- Updated repository URLs to point to macaly/almostnode

## [0.2.0] - 2025-01-31

### Added

- **Vite plugin** (`tabnode/vite`) - Automatically serves the service worker file during development
  ```typescript
  import { tabnodePlugin } from 'tabnode/vite';
  export default defineConfig({ plugins: [tabnodePlugin()] });
  ```

- **Next.js helpers** (`tabnode/next`) - Utilities for serving the service worker in Next.js apps
  - `getServiceWorkerContent()` - Returns service worker file content
  - `getServiceWorkerPath()` - Returns path to service worker file

- **Configurable service worker URL** - `initServiceWorker()` now accepts options
  ```typescript
  await bridge.initServiceWorker({ swUrl: '/custom/__sw__.js' });
  ```

- **Service worker included in sandbox files** - `generateSandboxFiles()` now generates `__sw__.js` along with `index.html` and `vercel.json`, making cross-origin sandbox deployment self-contained

### Changed

- Updated README with comprehensive Service Worker Setup documentation covering all deployment options

## [0.1.0] - 2025-01-30

### Added

- Initial release
- Virtual file system with Node.js-compatible API
- 40+ shimmed Node.js modules
- npm package installation support
- Vite and Next.js dev servers
- Hot Module Replacement with React Refresh
- Cross-origin sandbox support for secure code execution
- Web Worker runtime option
