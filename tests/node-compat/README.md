# Node module checks

Checks of a module's surface adapted from Node's own `test/parallel`, one file
per module, run by `npm test` with the rest of `tests/`. They are the engine's
own checks, not its measure: the measure is Node's own suite run unchanged
against a build by `scripts/node-tests.mjs`, and a module's number lives in
`BUILTINS.md`. `common.ts` maps Node's `assert` onto vitest's `expect`.
