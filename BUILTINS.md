# The engine's builtins, by kind

The rule is the substrate's ADR-0021: a builtin is Node's own file unless
Node's own is native. Each module below is one of two kinds, with its reason
and, for kind 1, its number on v0.2.14-volter.58 -- Node's own
`test-<module>-*` through `scripts/node-tests.mjs`.

Kind 1, Node's own file on a binding: Node's implementation is JavaScript, so
the engine runs that file and writes only what libuv or V8 would have
answered. Kind 2, the engine's own: Node's is native and the tab has no twin,
or the module is the engine itself.

A number is not a score. What each row's remainder is made of is in FORK.md's
table, row by row; a third of it across the estate is the harness's own
(`--expose-internals`, `node:test`, `process.getuid`) rather than the engine's.

## Kind 1 -- Node's own file

| Module | Number on .58 | The binding under it |
|---|---|---|
| `path` | no tests of its own here | none; it is pure |
| `net` | 109 of 151 | `tcp_wrap`, `pipe_wrap`, `stream_wrap`: the engine's loopback pairing and its port registry |
| `child_process` | 63 of 109 | `process_wrap`, `spawn_sync`, `tty_wrap`, the IPC flavour of `pipe_wrap` |
| `stream` | 158 of 171 | none; eighteen `internal/streams/*` files over `events`, `buffer` and `string_decoder` |
| `buffer` | 50 of 64 | `buffer`: encode, decode, compare, search, fill, copy, swap over `TextEncoder` and `TextDecoder` |
| `events` | 2 of 9 | none; `internal/event_target`'s two questions are answered over the realm's `EventTarget` |
| `util` | 11 of 27 | `util`: an object's non-index properties, a constructor's name, a Map's entries, the call stack, a `.env` file |
| `assert` | 4 of 16 | none; `internal/assert/*` is pure |
| `querystring` | 3 of 3 | none |
| `punycode` | no tests of its own here | `util` |
| `constants` | no tests of its own here | `constants`: the engine's own table |
| `diagnostics_channel` | 39 of 46 | `errors`: the run's uncaught door |
| `readline` | 10 of 20 | none; `internal/readline/*` over the engine's stdio |
| `os` | 0 of 6 | `os` and `credentials` over the engine's host answers |
| `tty` | 2 of 3 | `tty_wrap` |
| `http`, `https` | 315 of 377 | `http_parser`: llhttp's own WebAssembly build, undici's, vendored with its sha256 |
| `fs`, `fs/promises` | 127 of 246 | `fs`, `fs_dir`, `fs_event_wrap`: forty operations over the run's virtual filesystem; link and symlink answer EPERM |
| `zlib` | 23 of 59 | `zlib`: zlib's own inflate and deflate, as pako ports them, driven through `z_stream`. Brotli and Zstandard are codecs of their own and are refused by name, with what the engine does carry in the message. |
| `module`'s hooks | 34 of 38 | none; `internal/modules/customization_hooks.js`, one instance per run |
| `wasi` | not measured here | the engine's own preview-1 host |

`os` reads 0 because its six tests turn on the harness reading its own stack
frames (`call.getFileName`), not on `os`: the file is Node's own and its two
real defects -- `tmpdir()` ignoring `TMPDIR`, `setPriority` not round-tripping
-- are fixed.

## Kind 2 -- the engine's own, with the reason

| Module | Why it is not Node's file |
|---|---|
| `domain` | a consumer of the async-hooks machinery: Node's `domain.js` installs a trampoline the C++ layer calls to enter and leave a domain around every async callback. The engine has no such layer, so the vendored file loads and then catches nothing. Measured: it fails at `useDomainTrampoline is not a function`. |
| `async_hooks` | the same machinery seen from the other side -- an async id stack V8 and libuv maintain per resource. The engine's `AsyncLocalStorage` is the realm's, per run. |
| `timers` | Node's timer wheel over libuv's loop. The engine's timers are the realm's, counted per run by the run's own loop, which is what decides when a run is idle. |
| `string_decoder` | Node's current file needs a stateful binding -- the carry-over bytes of a half-read code point, held across calls in C++. The realm's `TextDecoder` does not expose that state, so Node's older pure-JavaScript file is what runs. |
| `url` | Node's `url.js` reaches `internal/url`, which is the C++ URL parser's own state machine. The realm's `URL` answers the WHATWG API but not that binding's contract. |
| `crypto` | Node's is OpenSSL; synchronous hashing has no WebCrypto twin, so the engine binds `@noble/hashes` and `sha.js` |
| `tls` | the page's TLS relay is the transport (Article 4) |
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
