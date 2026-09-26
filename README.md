<p align="center"><img src="https://brand.volter.ai/logo/tabnode/svg?size=96" alt="tabnode"></p>

# tabnode

**Node's own library, in a browser tab.**

tabnode runs Node programs in the browser. Its builtins are Node's own files, vendored unmodified from Node v22.18.0, on a binding layer that answers what libuv and V8's C++ would have answered: sockets, children, files, TTYs, the HTTP parser, zlib. Node's own test suite measures each module, and the numbers are in [`BUILTINS.md`](BUILTINS.md). Where Node's own module is native and the tab has no twin, the module is the engine's, with the reason at its site.

It is the Node engine of [`volter-ai/browser-substrate`](https://github.com/volter-ai/browser-substrate), the host it is built for, which installs it from npm by version.

[![npm](https://img.shields.io/npm/v/%40volter%2Ftabnode?label=%40volter%2Ftabnode)](https://www.npmjs.com/package/@volter/tabnode)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What is here

The engine is a library, not an application, and its surface is what a host embeds:

| Door | What it is |
|---|---|
| `createContainer()` | a filesystem, a runtime, an npm client and a server bridge as one object, with `run`, `execute` and the process questions a host asks about a named run |
| `VirtualFS` | the in-memory tree every builtin's `fs` binding reads and writes |
| `Runtime` | one guest realm: `require`, the module table of builtins, ESM lowered to CommonJS |
| `createRuntime()` | the same on the caller's thread or on a worker of the engine's own |
| `ServerBridge` | a page request answered by a guest's own `http` server, through the service worker |
| `createNodeResolver()` | Node's module resolution as a function over any filesystem |
| `esbuild`, `rollup` | the bundlers' own wasm builds, for a host that builds outside a run |

A guest's builtins are not here. A guest reaches them through the runtime's own module table (`src/runtime.ts`), which serves Node's vendored files from `src/node-lib/` and, for the modules Node writes in C++, the engine's own from `src/shims/`.

What the engine does not answer: a package it does not ship. `ws`, `chokidar`, `readdirp` and `fsevents` were imitated here once; each is an ordinary package over a builtin that is Node's own now, so a project installs it and it runs unchanged.

---

## Using it

```bash
npm install @volter/tabnode
```

Node 20.19 or later; the package is ES modules only. Every export is described in [`docs/api/`](docs/api/README.md), generated from the declarations at each release.

```typescript
import { createContainer } from '@volter/tabnode';

const container = createContainer();
container.vfs.writeFileSync('/hello.js', `
  const fs = require('fs');
  fs.writeFileSync('/out.txt', 'from a tab');
  console.log(fs.readFileSync('/out.txt', 'utf8'));
`);
const { stdout, exitCode } = await container.run('node /hello.js');
```

A guest server is reached through the bridge, at `/__virtual__/{port}/`, once the page has registered the service worker this package ships as `dist/__sw__.js`. A Vite host gets that route from the plugin:

```typescript
// vite.config.ts
import { tabnodePlugin } from '@volter/tabnode/vite';
export default { plugins: [tabnodePlugin()] };
```

---

## Working on it

```bash
npm install
npm run build:lib     # the bundle and its declarations, into dist/
npm run type-check    # tsc over src and tests
npm test              # the engine's own checks, vitest over tests/; some spawn a real node over dist/, so build first
```

A fix is a source commit on `main` that states which Node behaviour it restores, general to every program, never a fix that recognises a package or a framework. What measures it is Node's own suite, run against a build by `scripts/node-tests.mjs` (`scripts/NODE-TESTS.md`) and, on every push to `main`, by the `measure` workflow, whose job summary carries the numbers; [`BUILTINS.md`](BUILTINS.md) holds each module's number and what its remainder is made of. [`CONTRIBUTING.md`](CONTRIBUTING.md) says how a change is made and [`RELEASING.md`](RELEASING.md) how a release is cut; what each release changed is in [`CHANGELOG.md`](CHANGELOG.md), and a vulnerability is reported the way [`SECURITY.md`](SECURITY.md) says.

---

## About this fork

This repository began as `macaly/almostnode` at its version 0.2.14, a Node-in-the-browser engine whose builtins were hand-written imitations. The fork replaced them, module by module, with Node's own library files on a binding layer, deleted upstream's demos, sites and hand-written framework servers, and kept only the engine. Its history is its own from the first commit; upstream's copyright notice stays in [`LICENSE`](LICENSE) beside this project's. Releases through `v0.2.14-volter.88` counted up from upstream's version; from `v0.3.0` the version is the fork's own semver line.

---

## License

MIT, [`LICENSE`](LICENSE). Node's own library files under `src/node-lib/` are Node's, under Node's MIT licence beside them; what else is carried from elsewhere is listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
