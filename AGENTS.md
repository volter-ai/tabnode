# tabnode — rules for the agent working this repository

- **What this is.** The Node engine of `volter-ai/browser-substrate`, a fork of `macaly/almostnode`. `CONSTITUTION.md` is what it must remain; `FORK.md` is how a fix, a release and a measurement are done; `CLAUDE.md` is the tour of the tree.
- **A fix goes toward Node, at source.** It states which Node behaviour it restores, is general to every program, and never recognises a package, a project or a framework. A module of the engine's own exists only where Node's is native and the tab has no twin, with the reason at its site.
- **The engine never imitates a package.** A package that sits on a builtin is installed by the project and runs unchanged.
- **Git.** Fixes land on `main`. `dist/` is ignored on `main` and tracked on `release`; a release is cut the way `FORK.md` says: tagged `v0.2.14-volter.<n>`, published to npm as `@volter/tabnode` at that version, and the substrate moves its pin to that version.
- **No gates.** No CI, no required checks, no merge gate. What is fast enough to check belongs in the committer's hands at the moment of the change.
- **Verification is reading the code and the substrate's own doors.** No test run from here while building.
- **Do not edit** `LICENSE`, or the vendored files under `src/node-lib/`: a bug in one of those is fixed by moving to a newer Node, never by an edit.
