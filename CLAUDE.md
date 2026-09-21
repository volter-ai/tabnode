# tabnode

## What this is

tabnode runs Node in the browser: Node's own library files on bindings written once, an in-memory virtual filesystem, npm installation, and a service worker answering a guest server's port. It is a library; the host it is built for is `volter-ai/browser-substrate`, which installs it from npm by version. `CONSTITUTION.md` is what it must remain, `CONTRIBUTING.md` and `RELEASING.md` hold the rules for changing and releasing it, and `BUILTINS.md` names every builtin's kind, number and remainder.

## Core principle

**Never write library-specific shim code. Fix the platform instead.**

When a package does not work, the fix goes toward Node: a builtin that is Node's own file is fixed in its binding, and a module of the engine's own that has grown a patch group is replaced with Node's own file, never a package-specific adapter. The engine never imitates an npm package: a package that sits on a builtin is installed by the project and runs unchanged.

## Architecture

- **Runtime** (`src/runtime.ts`) — one guest realm: `require`, the module table, ESM lowered to CommonJS
- **Node's library** (`src/node-lib/`) — v22.18.0's own files, byte for byte, over `src/node-lib/binding/`, which answers what libuv and V8 would have
- **The engine's own modules** (`src/shims/`) — only where Node's is native and the tab has no twin, each with its reason at its site (`BUILTINS.md`, Kind 2)
- **VirtualFS** (`src/virtual-fs.ts`) — the in-memory tree every `fs` binding reads
- **PackageManager** (`src/npm/`) — real packages fetched, extracted and lowered through esbuild-wasm
- **ServerBridge** (`src/server-bridge.ts`) — a page request answered by a guest's own `http` server, at `/__virtual__/{port}/`
- **just-bash** — the shell behind `container.run`, with `node` and `npm` as commands
- **Code transforms** (`src/code-transforms.ts`) — ESM lowered to CommonJS over acorn's AST

## Commands

```bash
npm run build:lib    # the bundle and its declarations, into dist/
npm run type-check   # tsc over src and tests
npm run docs:api     # docs/api/ from the declarations; the release script runs it
```

There is no dev server, no demo page and no end-to-end suite here: this repository is the engine, and what drives it is the substrate's tab.

## Measurement

Node's own suite, run against a build by `scripts/node-tests.mjs` (`scripts/NODE-TESTS.md`), is what measures a module. `BUILTINS.md` carries each module's number and what each remainder is made of; the `measure` workflow prints the same numbers on every push to `main`, and blocks nothing. The `tests/` directory holds the engine's own checks; they are not run from here while building.

## Where to find more

- **`RELEASING.md`** — the release procedure; **`CONTRIBUTING.md`** — what a change is
- **`BUILTINS.md`** — every builtin, its kind, its number and the binding under it
- **`NET-AND-CHILD-PROCESS.md`** — how sockets and children are answered
- **`ROADMAP.md`** — what is intended; **`CHANGELOG.md`** — what landed
