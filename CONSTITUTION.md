# What tabnode is and must remain

tabnode is Node in a browser tab: Node's own library files, vendored unmodified from v22.18.0, on a binding layer
written once that answers what libuv and V8's C++ would, inside a loader with an in-memory virtual filesystem,
npm installation, esbuild-wasm transformation and a service worker that answers a guest server's port. Where
Node's own module is native and the tab has no twin, the module is the engine's, with its reason in `BUILTINS.md`.
This repository is Volter's fork of `macaly/almostnode`, patched toward Node as source and measured by Node's own
suites through `volter-ai/browser-substrate`, which consumes it by tag; the fork's rules are `FORK.md`.
`ROADMAP.md` holds what is intended and `CHANGELOG.md` what landed: together they are this project's record.
Changing this file is the owner's act.

## Invariants

- **The engine is corrected only toward Node, at source.** A fix states which Node behaviour it restores, is
  general to every program, and never recognises a package, a project or a framework. It lands here, never as a
  patch of this build in a consumer.
- **A builtin is Node's own file unless Node's own is native.** A module of the engine's own carries the reason
  at its site and a row in `BUILTINS.md`; it is replaced by Node's file as soon as a binding can answer it.
- **The engine answers builtins, never packages.** A package that sits on a builtin is installed by the project
  and runs unchanged. An imitation of one under a package's name hands a program something it did not install.
- **Node's own tests are the measure.** A number comes from Node's own suite run against a build, and what a
  remainder is made of is written down rather than assumed.
- **Done means true in the tab.** A completion holds where the engine is used, which is the substrate's tab, not
  where a commit's subject claims it.

## What this project will not become

- **Not an application.** No demo, no site, no dev server of its own, no framework of its own: what drives the
  engine is the substrate's tab.
- **Not a framework's implementation.** A framework's routing, rendering and hot reload are that framework's own
  code, run as a guest program. The engine that once hand-wrote a Next and a Vite dev server is not that engine.
- **Not a VM.** No Linux kernel, no process table of its own beyond what a run needs to answer Node.
