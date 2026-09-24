# The engine's builtins, by kind

The rule is the substrate's ADR-0021: a builtin is Node's own file unless
Node's own is native. Each module below is one of two kinds, with its reason
and, for kind 1, its number on v0.2.14-volter.58 -- Node's own
`test-<module>-*` through `scripts/node-tests.mjs`.

Kind 1, Node's own file on a binding: Node's implementation is JavaScript, so
the engine runs that file and writes only what libuv or V8 would have
answered. Kind 2, the engine's own: Node's is native and the tab has no twin,
or the module is the engine itself.

A number is not a score. Each row says what its remainder is made of; a third
of it across the estate is the harness's own (`--expose-internals`, `node:test`,
`process.getuid`) rather than the engine's. The `measure` workflow prints every
row's number on each push to `main`.

A number measured before `v0.2.14-volter.49` counted some tests that were
failing: the hand-written `EventEmitter` caught every listener's throw and
printed it, so a test whose assertion failed inside a listener exited 0. A row
measured before .49 is an upper bound, not a measurement; the rows below are
from .58.

## Kind 1 -- Node's own file

| Module | Number on .58 | The binding under it | What still fails |
|---|---|---|---|
| `path` | no tests of its own here | none; it is pure | |
| `net` | 109 of 151 | `tcp_wrap`, `pipe_wrap`, `stream_wrap`: the engine's loopback pairing and its port registry | a third are the harness's (`internal/test/binding`, `node:test`, `process.send`, `process.getuid`, `--expose-internals`); the rest are the binding's synchronous writes, which queue nothing, so `bufferSize`, `bytesWritten` mid-write, `drain` and cork batching read 0, and the `autoSelectFamily` timing tests, which need a second address family to race |
| `child_process` | 72 of 109 | `process_wrap`, `spawn_sync`, `tty_wrap`, the IPC flavour of `pipe_wrap` | signals, timeouts and buffer limits on synchronous children, which run on a thread with no process to kill (`ROADMAP.md`); the harness's `node:test` and `--expose-internals` |
| `stream` | 158 of 171 | none; eighteen `internal/streams/*` files over `events`, `buffer` and `string_decoder` | the harness's `node:test` |
| `buffer` | 50 of 64 | `buffer`: encode, decode, compare, search, fill, copy, swap over `TextEncoder` and `TextDecoder` | the harness's `--expose-internals`; a few `inspect` details |
| `events` | 2 of 9 | none; `internal/event_target`'s two questions are answered over the realm's `EventTarget` | four are the harness's (`--expose-internals` for `internal/event_target`, `node:test`); two need an `EventTarget` whose listeners can be enumerated, which the DOM does not allow; one reads a stack shape |
| `util` | 11 of 27 | `util`: an object's non-index properties, a constructor's name, a Map's entries, the call stack, a `.env` file | six are the harness's (`internal/util`, `internal/test/binding`, `node:test`); three are a proxy's target, a promise's state and a severed prototype's constructor, which V8's C++ answers and the realm does not; one wants an ES module namespace object, which the engine's lowering does not make; the rest are `inspect` details |
| `assert` | 4 of 16 | none; `internal/assert/*` is pure | the harness's `node:test`, and the stack and source reading of a failed assertion |
| `querystring` | 3 of 3 | none | |
| `punycode` | no tests of its own here | `util` | |
| `constants` | no tests of its own here | `constants`: the engine's own table | |
| `diagnostics_channel` | 39 of 46 | `errors`: the run's uncaught door | the harness's `node:test` |
| `readline` | 10 of 20 | none; `internal/readline/*` over the engine's stdio | a TTY the tests can write escape sequences at; `node:test` |
| `os` | 0 of 6 | `os` and `credentials` over the engine's host answers | all six turn on the harness reading its own stack frames (`call.getFileName`), not on `os` |
| `tty` | 2 of 3 | `tty_wrap` | a real terminal's window size |
| `http`, `https` | 315 of 377 | `http_parser`: llhttp's own WebAssembly build, undici's, vendored with its sha256 | the `--expose-internals` harness tests; llhttp's own version differs from the one Node 22.18 links, so two error codes read as that build names them; `http2` is not ported |
| `fs`, `fs/promises` | 127 of 246 | `fs`, `fs_dir`, `fs_event_wrap`: forty operations over the run's virtual filesystem; link and symlink answer EPERM | a third are the harness's (`--expose-internals`, `node:test`, `process.getuid`); the rest are a tree with no kernel behind it, no uid or gid, no permission bits to refuse a read, and link and symlink answering EPERM, and the tests that measure exactly those |
| `zlib` | 23 of 59 | `zlib`: zlib's own inflate and deflate, as pako ports them, driven through `z_stream`. Brotli and Zstandard are codecs of their own: Brotli decompression is answered by `brotli`'s pure-JavaScript decoder over the whole stream (a pre-compressed file read through `createBrotliDecompress`), and Brotli compression and Zstandard are refused by name, with what the engine does carry in the message. | 11 are Brotli and Zstd, separate codecs with their own bindings, not ported; 8 are the harness's `node:test`. Not a wasm build, and measured rather than assumed: pako's public `Inflate`/`Deflate` replace the caller's output buffer the instant it fills, so they cannot answer Node's contract; `pako/lib/zlib/*` is zlib's `inflate.c` and `deflate.c` ported line for line, honouring `next_out`/`avail_out` as the C does, which is the interface Node's own binding sits on. No zlib wasm build exists to vendor, and compiling `deps/zlib` would mean running a C toolchain, which this project does not do |
| `module`'s hooks | 34 of 38 | none; `internal/modules/customization_hooks.js`, one instance per run | two require builtins the engine does not have (`node:sea`, `node:sqlite`, `node:test`); one has a load hook answer with a WebAssembly module, which the loader does not compile; one spawns `node --require <hooks> <file.cts>` with `--experimental-strip-types`, a command line the engine's `node` does not take. Where the evidence stops: the row measures `module.registerHooks`; Node's suite has no in-process test of `module.register` (its six spawn a Node with `--loader`), so the asynchronous half is measured on the shape that asked for it, openvscode-server 1.109.5's extension host hook, run through the engine |
| `wasi` | not measured here | the engine's own preview-1 host | 7 of 12 in `test/wasi` (`ROADMAP.md`) |

`os`'s file is Node's own, and its two real defects, `tmpdir()` ignoring
`TMPDIR` and `setPriority` not round-tripping, are fixed.

## Kind 2 -- the engine's own, with the reason

| Module | Why it is not Node's file |
|---|---|
| `domain` | a consumer of the async-hooks machinery: Node's `domain.js` installs a trampoline the C++ layer calls to enter and leave a domain around every async callback. The engine has no such layer, so the vendored file loads and then catches nothing. Measured: it fails at `useDomainTrampoline is not a function`. |
| `async_hooks` | the same machinery seen from the other side -- an async id stack V8 and libuv maintain per resource. The engine's `AsyncLocalStorage` is the realm's, per run. |
| `timers` | Node's timer wheel over libuv's loop. The engine's timers are the realm's, counted per run by the run's own loop, which is what decides when a run is idle. |
| `string_decoder` | Node's current file needs a stateful binding -- the carry-over bytes of a half-read code point, held across calls in C++. The realm's `TextDecoder` does not expose that state, so Node's older pure-JavaScript file is what runs. |
| `url` | Node's `url.js` reaches `internal/url`, which is the C++ URL parser's own state machine. The realm's `URL` answers the WHATWG API but not that binding's contract. |
| `crypto` | Node's is OpenSSL; synchronous hashing has no WebCrypto twin, so the engine binds `@noble/hashes` and `sha.js` |
| `tls` | the page's TLS relay is the transport (Article 4); on the loopback a TLS server listens as a net server and a TLS connect pairs with it, with no wire to protect |
| `dns` | a tab resolves nothing; the World answers |
| `vm` | V8 contexts; the engine's guest-global scoping is the tab's `vm` |
| `worker_threads` | Web Workers |
| `module` | the loader itself, entangled with the engine's transforms and its ESM lowering. Its customization hooks are Node's own file, above. |
| `process` | the bootstrap, one per run |
| `dgram`, `cluster`, `http2`, `inspector`, `v8`, `trace_events`, `repl` | refusing stubs: no UDP, no fork-and-share, no nghttp2, no inspector in a tab. Each refusal names why at its site. |
| `esbuild`, `rollup` | not builtins: the engine's doors to the bundlers' own wasm builds |

## What used to be here

`ws`, `chokidar`, `readdirp` and `fsevents` were imitations of npm packages
and are gone: each is an ordinary package over a builtin that is now Node's
own, so a project installs it and it runs unchanged. `fs`, `http`, `https`,
`stream`, `buffer`, `events`, `util`, `net`, `child_process`, `assert`,
`querystring`, `punycode`, `constants`, `diagnostics_channel`, `readline`,
`os`, `tty` and `zlib` were hand-written modules in `src/shims/` and are gone
too -- the files are deleted, not deprecated, and what each one's row above
says is what a guest gets now.

That sentence was written when each module's row changed and was true of what
a guest got, but eighteen of the files themselves sat in `src/shims/` unread
for twenty-odd releases, imported by `runtime.ts` and never served. They are
deleted now, and nothing imports them: `assert`, `querystring`, `readline`,
`tty`, `chokidar`, `readdirp` and `fsevents` with the last of them, the rest
in the releases that moved their rows.

What remains of `src/shims/fs.ts` is sixty lines and is not an `fs`: it is
`createFsShim`, which names a tree for the length of a call so that a caller
with a tree but no run -- WASI, the substrate's rolldown build -- can use
Node's own `fs` over it.
