# ADR-0016: Node's C libraries are one module built from Node's deps, and TLS is OpenSSL through memory BIOs

Status: Accepted.

Date: 2026-11-10. Served: browser-substrate ADR-0218 §1 and §3 (browser-substrate PR #276, "Tabnode is Node's facade,
and it has no real fallback in a tab"; "Tabnode's V8 glue is a declared subset with named refusals") and ROADMAP 109,
card VO-3806's `node` row: "Tabnode runs Node's own JavaScript … over Node's own C libraries built from Node's deps/
as one module that needs no linker, OpenSSL first (through memory BIOs, as Node does: the tab has no TLS today, and
Rallly's `prisma migrate deploy` hit it, 02b0d4899), then llhttp and Ada, compression (zlib, brotli, zstd), nghttp2".
Basis: the Node-fidelity study and its independent review (card VO-3806's comments; the review: "sound with changes").

## Context

### What Node is made of, below its JavaScript (read in Node v24.21.0's source tarball, SHA-256 a6f54def…94fc)

- **Node links its C libraries into one executable, with one libc.** OpenSSL is `deps/openssl/openssl` (OpenSSL 3.5.8,
  `VERSION.dat`), configured by `deps/openssl/config/Makefile:33-36`: `no-tests no-shared no-afalgeng enable-ssl-trace
  enable-fips zlib enable-brotli enable-zstd`, the last three for RFC 8879 certificate compression over Node's own
  `deps/zlib`, `deps/brotli` and `deps/zstd`. Node's own no-asm configurations are generated the same way, with
  `no-asm` added (`Makefile:70-79`). ncrypto (`deps/ncrypto`) is Node's C++ over OpenSSL with no V8 in it; Node's
  `src/crypto/*.cc` is the V8 binding over ncrypto and OpenSSL.
- **Node's TLS is OpenSSL driven through memory BIOs.** `TLSWrap` (`src/crypto/crypto_tls.cc`) gives each connection
  an `SSL` whose two BIOs are memory buffers (`NodeBIO`, `crypto_bio.cc`): `InitSSL` (476-529) sets them;
  ciphertext the underlying stream reads goes into `enc_in` (`OnStreamRead`, 1157-1201); `ClearOut` (786-911) runs
  `SSL_read` and hands the plaintext to JavaScript; `ClearIn` (913-968) and `DoWrite` (1014-1147) run `SSL_write`;
  `EncOut` (641-735) drains `enc_out` to the underlying stream as a write. OpenSSL never touches a socket.
- **`SecureContext`** (`src/crypto/crypto_context.cc`) is an `SSL_CTX`: `Init` (1534-1686) chooses the method and the
  protocol range and sets Node's defaults (no SSLv2/SSLv3, client renegotiation allowed, automatic chaining, the
  session cache mode, the ticket-key compatibility callback), and the rest (`SetKey`, `SetCert`, `AddCACert`,
  `AddRootCerts`, `SetCiphers`, `SetCipherSuites`, `SetECDHCurve`, `SetOptions`, …) are thin calls into OpenSSL.
- **Node's own JavaScript for TLS** is `lib/tls.js`, `lib/_tls_common.js`, `lib/_tls_wrap.js` and
  `lib/internal/tls/{common,secure-context,wrap}.js`. It reaches `internalBinding('tls_wrap')`,
  `internalBinding('crypto')` (`SecureContext`, the root-certificate calls, `getSSLCiphers`), and
  `internal/crypto/util` and `internal/crypto/x509`.

### What the engine does today (tabnode 2595132)

- `tls` is the engine's own module (`src/shims/tls.ts`): Node's stream contract over a TLS session the process's host
  offers (`TREE_TLS`, `src/host-tls.ts`). browser-substrate's Linux Node program offers none
  (`linux-virtual-filesystem.ts:26-28, 43-45`), so in the tab every handshake fails
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Rallly's `prisma migrate deploy` exited 1 on a missing
  `TLSSocket.secureConnecting` (browser-substrate 02b0d4899), a property Node's own `internal/tls/wrap.js` has.
- `crypto` is JavaScript: @noble/hashes and @noble/curves, WebCrypto for randomness and the asynchronous calls.
- Two of Node's C libraries already run as WebAssembly, each in its own module and memory: llhttp (undici 6.28.0's
  build, not Node's 9.4.3; `binding/llhttp-wasm.ts`) and Ada's IDNA (`binding/ada-idna-wasm.ts`, built from Node
  v24.21.0's `deps/ada` by wasi-sdk 34.0, ADR-0009 §3).

### What the substrate holds

- browser-substrate's `programs/native-providers/openssl/3.5.8-r0` is a recipe for OpenSSL 3.5.8 as a WALI library
  (`wasm32-linux-muslwali`: musl's pointer4/long8 ABI, a shared imported memory, `wali.*` system-call imports), with
  its preparation requirements still open. Such a library is part of a Linux process image: its memory is a
  process's user memory and its allocator is musl's over `brk`/`mmap`. Loading one into a Node process is the side-
  module linker, which the Linux host does not have (`packages/node/src/linux-tree-native.ts:9-14`; ADR-0231).
- A WebAssembly memory costs one of about 124 address-space regions per tab (ADR-0011, Context).

## Decision

### 1. One module, built from Node's own `deps/`, with no linker

`node-deps.wasm` is one WebAssembly module holding the C libraries Node links that never reach the kernel, built from
Node v24.21.0's own source tarball (pinned by digest) by `scripts/build-node-deps-wasm.sh`:

- **Now:** OpenSSL 3.5.8 (`deps/openssl/openssl`), ncrypto (`deps/ncrypto`), and the engine's export layer
  (`scripts/node-deps/tabnode_deps.cc`, §3).
- **Then, in the row's order, into the same module:** llhttp 9.4.3 and Ada 4.0.0 whole (`deps/llhttp`, `deps/ada`;
  `http_parser` and a vendored `internal/url`), so their two memories go; zlib (Node's Chromium fork), brotli 1.2.0
  and zstd 1.5.7 (`deps/zlib`, `deps/brotli`, `deps/zstd`; the `zlib` binding, and OpenSSL's certificate compression
  as Node configures it); nghttp2 1.70.0 (`deps/nghttp2`; Node's own `http2` JavaScript).
- **Toolchain:** wasi-sdk 34.0, the release ADR-0009 §3 already pins for Ada, digest-checked, targeting
  `wasm32-wasip1` as a reactor. The libraries are linked statically with one libc (wasi-libc) and one allocator, as
  the `node` executable links them, into a memory of the module's own, not shared. The module imports nothing but
  WASI's calls (§2) and the engine's TLS callbacks (§4); nothing links it, and nothing else is loaded into it.
- **Why not the WALI library now.** A WALI library is a process image's part, loadable only by a linker the Linux host
  lacks. The libraries that need the kernel (SQLite over files, `getaddrinfo`, c-ares, native addons) wait for that
  linker (browser-substrate ROADMAP 109). When it lands, this module is rebuilt from the same sources and the same
  configuration by the WALI SDK as the host image's main, so addons resolve libc and malloc against one image
  (browser-substrate ADR-0231 §3). That rebuild is the linker's change, not this record's.
- **OpenSSL's configuration is Node's, with each difference named.** `linux-generic32` (wasm32 is ILP32) with Node's
  options, and `no-asm` as Node's own no-asm configurations have it. A module with no dynamic loader, no threads and
  no sockets adds `no-dso no-threads no-sock no-async no-secure-memory no-ui-console no-apps`, and so leaves out
  `enable-fips`, whose provider is a loadable module. Each loss is refused by name in the engine, never approximated
  (browser-substrate ADR-0218 §3): `crypto.setFips(true)` and `--enable-fips`/`--force-fips`; `--secure-heap`
  (`crypto.secureHeapUsed()` reports none); engines (`crypto.setEngine`, `clientCertEngine`, `privateKeyEngine`);
  an OpenSSL configuration file (`--openssl-config`, `OPENSSL_CONF`), since the module reads no files. `zlib`,
  `enable-brotli` and `enable-zstd` are left out until those libraries enter the module; until then
  `getCertificateCompressionAlgorithms()` answers the empty list the built OpenSSL has, and a `certificateCompression`
  option naming an algorithm is refused by name. Node's own `doc/build.info` is absent from its stripped tree; the build writes an
  empty one in its scratch copy so `Configure` runs, and compiles nothing differently.

### 2. Instantiated once per realm; bytes cross by copy

- The module is compiled once per worker, on the realm's first TLS or crypto call, and instantiated once per realm.
  Every `SecureContext` and `TLSWrap` of the realm lives in that instance's memory; nothing of it crosses realms, so
  a realm's end frees it with the realm.
- Bytes cross by copy, as llhttp's and Ada's do: a `Buffer` is copied into the module's memory for a call and the
  answer is copied out. A `Buffer` is never placed in the module's memory, and the module's memory is not shared, so
  every WebIDL API without `[AllowShared]` can still read what it hands out.
- **WASI imports.** `random_get` is the engine's one randomness source and `clock_time_get` its one clock, taken as
  they are: this record does not decide them (timers, clocks, randomness and the console are designed separately),
  and when that design moves them the module follows. `fd_write` answers `ENOSYS` (OpenSSL writes nothing it needs
  read; `enableTrace` output reaches the program through the engine, §4). `environ_*` answer an empty environment;
  `proc_exit` and `abort` throw an error naming the module. Every other WASI call answers `ENOSYS`.

### 3. The export layer is Node's C++ with its V8 half removed

`tabnode_deps.cc` exports flat C functions (`tn_*`) whose bodies are the OpenSSL half of Node's
`crypto_context.cc` and `crypto_tls.cc`, line for line where the C++ is OpenSSL, each function naming the lines it
carries; the V8 half (argument unwrapping, `Local<Object>` results, `MakeCallback`) is the binding's JavaScript. Where
ncrypto already has the code (`X509View`, `SSLPointer`, `BIOPointer`, `CSPRNG`, the cipher and curve lists), the
export layer calls ncrypto. The certificate half, Node's `X509ToObject` and the issuer walk of `GetPeerCert`
(`crypto_x509.cc:611-855`, `crypto_common.cc:80-171`), is carried the same way, so `getPeerCertificate()` answers
the object `tls.checkServerIdentity` reads. Errors come back as OpenSSL's error queue, read by the binding into Node's own error
shape (`ThrowCryptoError`: the message is `ERR_error_string_n`'s, with `library`, `reason` and `code`).

### 4. TLS: Node's own JavaScript over `tls_wrap` and `SecureContext` bindings on the module

- **Node's own files.** `tls.js`, `_tls_common.js`, `_tls_wrap.js`, `internal/tls/{common,secure-context,wrap}.js` and
  `internal/js_stream_socket.js` are vendored unmodified from v24.21.0. `src/shims/tls.ts`, its `DuplexStreamHandle`
  and the `TREE_TLS` door (`src/host-tls.ts`) are deleted.
- **`internalBinding('tls_wrap')`** (`src/node-lib/binding/tls_wrap.ts`) is `TLSWrap` as Node's, a `LibuvStreamWrap`:
  `wrap(handle, context, isServer, hasActiveWriteFromPrevOwner)` makes it through the process's binding surface (so
  the prototype `wrap.js` extends is its own) over the underlying stream handle (a TCP or Pipe handle, or a
  `JSStream`), with an `SSL` whose `rbio` and `wbio` are `BIO_s_mem()`. The wrap is the underlying stream's reader,
  as Node's `PushStreamListener` makes it; its reads go into `enc_in` and `Cycle` runs (`ClearIn`, `ClearOut`,
  `EncOut`); writes are `DoWrite`'s, completing when `EncOut`'s write to the underlying stream does
  (`InvokeQueued`); `shutdown` is `close_notify` and then the underlying stream's. `onhandshakestart`,
  `onhandshakedone`, `onnewsession`, `onkeylog`, `oncertcb`, `onerror` and `ALPNCallback` are called where Node calls
  them; OpenSSL reaches them through the module's `tabnode` imports, synchronously, inside the `SSL_*` call that
  raised them, as in Node. Where Node defers to `SetImmediate` (a write the underlying stream finished synchronously,
  `EncOut` inside `DoWrite`), the binding defers to its binding turn, as the engine's stream bindings do.
- **`internalBinding('crypto')`** (`src/node-lib/binding/crypto.ts`) is, for now, what `tls` reaches: `SecureContext`
  (an `SSL_CTX` in the module, initialised as `SecureContext::Init`), the root-certificate calls and `getSSLCiphers`.
  An error Node throws from C++ is made as its `THROW_ERR_*` makes it, the message as given with its `code`. The
  binding's `crypto` constants group is Node's `DefineCryptoConstants`, compiled against the built OpenSSL
  (`node_constants.cc:866-1091`, extracted by the build); the options table answers Node's TLS options, with
  `--tls-cipher-list` Node's `DEFAULT_CIPHER_LIST_CORE` from the same source.
- **`internalBinding('js_stream')`** is Node's `JSStream`, which Node's own `JSStreamSocket` drives (ADR-0013 §2).
- **The root store is the image's bundle plus `NODE_EXTRA_CA_CERTS`, as Node's `--use-openssl-ca` makes it.** The
  store a client verifies against is `/etc/ssl/certs/ca-certificates.crt` with the file `NODE_EXTRA_CA_CERTS` names,
  read through the process's files once for the realm's instance, and the options table answers `--use-openssl-ca`
  true, so `tls.getCACertificates('default')` agrees with it. *Why:* an image lays its World's CA in that bundle, so
  a World twin's certificate verifies as the image's own programs verify it; Node's default, its bundled store
  (`getBundledRootCertificates()`, compiled into the module), would refuse every twin. Node's default as a realm's
  roots is browser-substrate ROADMAP's "96's Node bundled root store", a named difference until then.
  `tls.setDefaultCACertificates()` replaces the store as Node's `ResetRootCertStore` does.
- **`InternalX509Certificate` is refused by name until `crypto` is OpenSSL's.** `internal/tls/wrap.js` takes it from
  `internal/crypto/x509` for `getPeerX509Certificate()` and `getX509Certificate()`. *Why:* Node's class is
  `crypto`'s `X509Certificate`, whose `publicKey` is a `KeyObject` of `internal/crypto/keys`, the engine's noble one
  until §5; answering it half from OpenSSL and half from noble would be an approximation. A handshake never
  constructs one: the binding's `getPeerX509Certificate()` answers a handle only for its presence, which
  `wrap.js`'s verification reads. `getPeerCertificate()` is whole (Node's `X509ToObject` and `GetPeerCert`, §3).
  `internal/crypto/util` is hand-bound with Node's own `toBuf`, the one name `secure-context.js` takes.
- **`TREE_TLS` is retired, a minor release.** The package no longer exports `TREE_TLS` or its types
  (`src/index.ts`): an exported-surface change, which RELEASING.md makes a minor release. *Why:* a process's TLS is
  now the library inside it, as a Linux process's is, so a host has nothing to offer; browser-substrate's Linux Node
  program offered none, and nothing of the substrate imports it.
- **The page bridge's TLS ports** are found from the listener itself: a port whose listening handle's owner is a
  `net.Server` holding `_sharedCreds`, the SecureContext Node's `tls.Server` keeps, answers TLS (`listensWithTls`).
- **Refused by name, each an open defect, not a platform limit:** a server's session resumption events
  (`resumeSession`, `newSession`: Node's ClientHello parser is not carried), PSK, OCSP stapling (`requestOCSP`,
  `OCSPRequest`), `enableTrace`/`--trace-tls`, `pfx`, certificate compression (until zlib, brotli and zstd enter the
  module), `getSharedSigalgs()`. Engines are refused by Node's own `ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED`, the
  build having none.
- **What stays the engine's:** the loop's dispatch. The wrap's callbacks run on the realm's loop as every other
  binding's do (ADR-0003); the microtask drain is the V8 glue's (browser-substrate ADR-0218 §3).

### 5. `crypto` follows on the same module

Node's `lib/internal/crypto/*` moves onto the module's OpenSSL the same way, binding by binding (hashes, HMAC,
ciphers, `KeyObject`, sign and verify, key generation, X509, `DiffieHellman`, ECDH, KDFs), each replacing its noble or
WebCrypto answer. Randomness is not among them in this record (§2).

### 6. Measured as ADR-0021 orders

Each step is a move from the engine's own module to Node's file, measured before and after by Node's own
`test/parallel/test-tls-*`, `test-https-*` and `test-crypto-*` through `scripts/node-tests.mjs`, when a measurement
is asked for. `process.versions.openssl` names the built OpenSSL (`3.5.8`), and the other `process.versions` entries
name what runs (browser-substrate ADR-0218 §3).

## Where the evidence stops

- Built on 2026-11-10 (themachine, wasi-sdk 34.0 arm64-macos) by `scripts/build-node-deps-wasm.sh`, about 40 s:
  OpenSSL 3.5.8 from Node v24.21.0's `deps/openssl` with the configuration in §1 (`libcrypto.a` 6,197,218 bytes,
  `libssl.a` 902,392 bytes, no compiler warning), ncrypto and the export layer, linked into `node-deps.wasm`,
  3,004,103 bytes (4.0 MB as the base64 the bundle carries). Two builds in different scratch directories gave the
  same bytes. Its imports are WASI's (`random_get`, `clock_time_get`, `environ_*`, `proc_exit`, and the file calls
  OpenSSL's loaders reach) and the five `tabnode` callbacks. Its compile and instantiation times are not yet read in
  a tab.
- Built: the module, its realm loader (`src/node-lib/binding/node-deps.ts`), the `tls_wrap`, `crypto` and
  `js_stream` bindings, the vendored tls files, and the rewiring (§4). The engine builds with the repository's build;
  no suite, test or typecheck was run (AGENTS.md).
- Nothing here has run in a tab. The proof is a product run: a TLS client's handshake from a realm in the tab
  (Rallly's `prisma migrate deploy` against a granted host, or the World's TLS twin).
- The cost of wasm against native crypto is not measured: WebCrypto and the browser's TLS run native, and WebAssembly
  has no AES or SHA instructions. ADR-0218 §0 makes speed the objective, so the asynchronous WebCrypto answers are
  not retired before that number is read.
