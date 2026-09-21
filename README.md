# tabnode

**Node's own library, in a browser tab.**

tabnode runs Node programs in the browser. Its builtins are Node's own files, vendored unmodified from Node v22.18.0, on a binding layer that answers what libuv and V8's C++ would have answered: sockets, children, files, TTYs, the HTTP parser, zlib. Node's own test suite measures each module, and the numbers are in [`BUILTINS.md`](BUILTINS.md). Where Node's own module is native and the tab has no twin, the module is the engine's, with the reason at its site.

It is the Node engine of [`volter-ai/browser-substrate`](https://github.com/volter-ai/browser-substrate), which consumes it by tag. This repository is a fork of `macaly/almostnode`; [`FORK.md`](FORK.md) names the upstream and holds the rules for changing, releasing and measuring it.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What is here

The engine is a library, not an application. It has one consumer, the substrate, and its surface is what that consumer embeds:

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
npm install github:volter-ai/tabnode#v0.2.14-volter.<n>
```

```typescript
import { createContainer } from 'tabnode';

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
import { tabnodePlugin } from 'tabnode/vite';
export default { plugins: [tabnodePlugin()] };
```

---

## Working on it

```bash
npm install
npm run build:lib     # the bundle and its declarations, into dist/
npm run type-check    # tsc over src and tests
npm test              # the engine's own checks, vitest over tests/
```

A fix is a source commit on `main` that states which Node behaviour it restores, general to every program, never a fix that recognises a package or a framework. What measures it is Node's own suite, run against a build by `scripts/engine-fork/node-tests.mjs` in the substrate; `FORK.md` holds the release procedure and the module-by-module table of what still fails.

---

## License

MIT, [`LICENSE`](LICENSE). Node's own library files under `src/node-lib/` are Node's, under Node's MIT licence beside them; what else is carried from elsewhere is listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
