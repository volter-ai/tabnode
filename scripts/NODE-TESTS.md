# Node's own tests as the engine's measure

`node-tests.mjs` runs files of Node's test suite as programs of the engine, in
Node, and counts the ones that exit 0. Each file runs in a process of its own
over a filesystem that mounts the checkout at `/workspace/app`, with a timeout.
The number is the module's row in `BUILTINS.md`; what the remainder is made of
is written up in `FORK.md`. A number is stated with the build it came from.

## The test tree

A sparse checkout of nodejs/node at v22.18.0, the version the library files
under `src/node-lib/` are vendored from, made beside this repository:

    git clone --filter=blob:none --no-checkout https://github.com/nodejs/node.git ../node-tests
    git -C ../node-tests sparse-checkout set test/common test/parallel test/fixtures test/wasi test/module-hooks test/es-module
    git -C ../node-tests checkout v22.18.0

## Running

    npm run build:lib
    node scripts/node-tests.mjs --tests ../node-tests --match test-path- --list-failures
    node scripts/node-tests.mjs --tests ../node-tests --dir test/wasi --match test-
    node scripts/node-tests.mjs --tests ../node-tests --match test-net- --engine <another build>/dist/index.mjs

`--match` is a file-name prefix (`test-stream-` by default), `--dir` the
directory under the checkout (`test/parallel`), `--engine` a build other than
this repository's `dist/index.mjs`, `--jobs` the parallelism (4), `--timeout`
the milliseconds a test may take (8000); `--list-failures` prints each failing
file with the first lines of its stderr. The summary groups failures by their
first error line, which is where a class shows itself.

## The prelude

Every test loads `test/common/index.js`, which reads things of `process` and
`net` the engine did not answer when the harness was written.
`diagnostic-prelude.cjs` (`--prelude scripts/diagnostic-prelude.cjs`) papers
over each gap so the tests behind it can be seen; it is a diagnostic, never the
number. Each line of it is a gap until a measurement without the prelude says
otherwise, at which point the line goes:

- `process.config` with `variables` (Node: the build's configuration).
- `process.umask()`.
- `process.features` (`debug`, `inspector`, `tls`).
- `process.execArgv`.
- `net.getDefaultAutoSelectFamilyAttemptTimeout` and its setter.
- The engine's own names on `globalThis` (`window`, `__browserRuntime*`,
  `__substrate*`) are visible to a guest and fail the suite's leaked-globals
  check; the check is off in the prelude.
- The helper re-executes `node` with a test file's `// Flags:`; under the
  engine there is no node to execute, so the flag check is off.
