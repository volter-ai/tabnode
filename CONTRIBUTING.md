# Contributing

tabnode is Node's own library in a browser tab, and a change to it goes toward Node. [`CONSTITUTION.md`](CONSTITUTION.md) is what the engine must remain, and [`RELEASING.md`](RELEASING.md) is how a release is cut.

## What a change is

- **It restores a Node behaviour.** The commit says which program died, what Node does, and what the engine did; the reason sits at the site in the code as well. Node's documentation and Node's own tests are the reference.
- **It is general.** A fix never recognises a package, a project or a framework. A package that sits on a builtin is installed by the project and runs unchanged; the engine does not imitate one.
- **It lands in a binding, not in Node's files.** `src/node-lib/` is Node v24.5.0's own library, unmodified; a bug in one of those files is fixed by moving to a newer Node. A builtin the engine answers itself (`src/shims/`, listed in [`BUILTINS.md`](BUILTINS.md)) exists only where Node's is native and the tab has no twin.
- **A change to the lowered text moves the prepared format, and that is a minor release.** A prepared module body is a file's lowered text kept under a name made of `PREPARED_MODULES_FORMAT`, the kind and the SHA-256 of the SOURCE (`src/prepared-key.ts`): nothing of the lowering is in the name. A change that makes the engine lower the same source to different text (a new argument to a wrapper call, another rewrite) leaves every body prepared before it loadable by name and silently stale. Such a change moves the format id in the same commit, so the older bodies are not found and are prepared again; it is breaking for a consumer that keeps prepared bodies, so it is cut as a minor release and never inside a patch.
- **Measurements are explicit work.** A module's number comes from Node's own suite run against a build (`scripts/node-tests.mjs`, [`scripts/NODE-TESTS.md`](scripts/NODE-TESTS.md)). Do not run incidental tests, suites, typechecks, lints, probes, or reviews during development, locally or remotely. When the user's task is a measurement, baseline, harness, or capability ledger, implementing and running it is the requested deliverable. Run it locally and retain the exact scope and conditions. Remote tests or measurements, especially GitHub Actions, require explicit user authorization for that remote run; a measurement request alone does not authorize remote execution. The manually dispatched `measure` workflow reproduces an explicitly requested remote measurement; it blocks nothing and is not a release gate.

## How to send one

1. Fork, branch from `main`, `npm install`, `npm run build:lib`.
2. Make the change without incidental development checks. If the task explicitly requests measurement, produce that measurement and its evidence.
3. Open a pull request against `main` with the commit message as the description. No check gates a merge; a maintainer reads the diff and merges it.

Releases are cut by a maintainer the way `RELEASING.md` says.

## What is not taken

A demo, a site, a dev server, a hand-written framework server, or a compatibility shim for one package: the engine is the engine and nothing else.

- **Upstream stays a source.** A change taken from `macaly/almostnode` arrives as a patch with its reason at the site, and `dist` is rebuilt after every release so the suite never measures a stale build.
