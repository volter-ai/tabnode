# ADR-0005: Behaviour that follows the image's Node line, one measured row at a time

Status: Accepted

Serves: "five vendor apps run unchanged". Unchanged includes the Node line the
vendor ships.

The engine carries one Node library, v24.21.0's own files, and a guest's
`process.version` is the version its image names (`NODE_VERSION`). A guest of
a `node:20` image is therefore told v20.x and given v24's behaviour. Carrying
a second library is not proposed. Instead `src/node-line.ts` holds a table of
behaviours keyed by the major of the same `process.version`, and the engine
consults it where a behaviour is known to differ.

A row is admitted only with its measurement beside it in that file: the
script under `scripts/node-line/`, the Node versions it ran on, the numbers.
A difference that is believed and not measured on the real Node of each line
is listed there as a candidate and changes nothing. Where the image names no
version the line is the library's, 24, and nothing changes.

The first row: on line 20 an `import()` that runs an ES module's body for the
first time settles after the loop has turned once; CommonJS by `import()` and
an already loaded ES module settle as before, and so does every other line.
Measured with `scripts/node-line/import-turns.cjs` on v20.20.2, v22.23.3,
v24.21.0 and v26.8.1. It was found on Cal.com (image `node:20`): Next fires a
preload of every entry from its server's constructor as a chain of awaited
imports, and with no turn between them the listener's first request was read
only when the chain ended, 10.1 s after the port opened.

Known and left: the library's own internals report v24.21.0 whatever the
guest is told (`src/node-lib/load.ts`). The library is 24's.

Each process says the line it answers as, and where that came from, once at
its start: `[boot-trace] {"event":"node-line", …}`.
