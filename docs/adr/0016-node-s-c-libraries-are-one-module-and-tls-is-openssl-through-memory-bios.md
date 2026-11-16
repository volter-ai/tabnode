# ADR-0016: Node's C libraries are one module built from Node's deps, and TLS is OpenSSL through memory BIOs

Status: Accepted; §1, §2 and §3 amended by ADR-0018 item 7 and ADR-0019: Node's C libraries are linked into the
`node` program in the process's memory, and the export layer is that program's.

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
- One of Node's C libraries already runs as WebAssembly, in its own module and memory: Ada's IDNA
  (`binding/ada-idna-wasm.ts`, built from Node v24.21.0's `deps/ada` by wasi-sdk 34.0, ADR-0009 §3).

### What the substrate holds

- browser-substrate's `programs/native-providers/openssl/3.5.8-r0` is a recipe for OpenSSL 3.5.8 as a WALI library
  (`wasm32-linux-muslwali`: musl's pointer4/long8 ABI, a shared imported memory, `wali.*` system-call imports), with
  its preparation requirements still open. Such a library is part of a Linux process image: its memory is a
  process's user memory and its allocator is musl's over `brk`/`mmap`. Loading one into a Node process is the side-
  module linker, which the Linux host does not have (`packages/node/src/linux-tree-native.ts:9-14`; ADR-0231).
- A WebAssembly memory costs one of about 124 address-space regions per tab (ADR-0011, Context).

## Decision

### 1. Node's C libraries are the `node` program's, built from Node's own `deps/`

OpenSSL 3.5.8 (`deps/openssl/openssl`) and ncrypto (`deps/ncrypto`) are in the WALI program `node`, Node's native
half in the Node process's memory (ADR-0019 §1), built from Node v24.21.0's own source tarball (pinned by digest) by
`scripts/build-node.sh` with the WALI SDK, and linked whole into it, as `node.gypi` links OpenSSL into Node's
executable (`node.gypi:416-418`), so an addon finds all of OpenSSL in the program.
The rest of ADR-0018 §1's libraries (llhttp, Ada, zlib, brotli, zstd, nghttp2) join it in that record's order.

- **C++ runtime.** ncrypto and the glue (§3) are C++ (Node's `-std=gnu++20 -fno-rtti -fno-exceptions`), over the WALI
  SDK's C++ runtime, libc++ and libc++abi as shared libraries, which the SDK's `c++` links (browser-substrate
  ADR-0238 §4).
- **OpenSSL's configuration is Node's, with each difference named.** Node's options (`deps/openssl/config/
  Makefile:33-36`: `no-tests no-shared no-afalgeng enable-ssl-trace enable-fips`) with `no-asm`, as Node's own no-asm
  configurations have it, generated once by Node's procedure and kept as source in `native/openssl` (ADR-0019 §1), and
  compiled as `openssl.gyp` compiles Node's sets, with Node's defines (`openssl.gyp`: `OPENSSL_NO_HW`,
  `OPENSSL_API_COMPAT=0x10100001L`, `STATIC_LEGACY`; `openssl_no_asm.gypi`: `OPENSSL_NO_ASM`; `openssl_common.gypi`:
  `TERMIOS`, OPENSSLDIR `/etc/ssl` and ENGINESDIR `/dev/null`; `common.gypi`: `OPENSSL_THREADS`, and
  `OPENSSL_NO_PINSHARED`, as for an executable that links its own OpenSSL). The legacy provider is built in, as Node's
  libopenssl holds it, from the set's own source list.
  The differences:
  - `linux-generic64`, where Node's sets are its hosts' targets: `wasm32-linux-muslwali` has a 64-bit `long` and
    32-bit pointers, OpenSSL's `SIXTY_FOUR_BIT_LONG`, the target browser-substrate's own OpenSSL recipe takes. Node's
    Makefile names no such target, and its no-asm rule is run for it (`native/openssl/README.md`).
  - RFC 8879 certificate compression: OpenSSL is configured with Node's `zlib`, `enable-brotli` and `enable-zstd`
    over Node's own deps in the program (ADR-0018 item 10), and the binding does not yet carry the compression, so
    `getCertificateCompressionAlgorithms()` answers the empty list, and a `certificateCompression` option naming an
    algorithm is refused by name.
  - MODULESDIR is the image's `/usr/lib/ossl-modules`, where Node's names its build tree.
  - The set's include directories come before OpenSSL's own: Node reaches a set's generated headers through headers in
    `openssl/include` that choose among its sets by the compiler's architecture macros and name no wasm32 target, and
    with one set its own headers are read directly.

### 2. In the process's memory; bytes cross by copy

- Every `SecureContext` and `TLSWrap` of a process lives in its memory, made with its `malloc`, as a Node process's
  do; a process's end frees them with it.
- Bytes cross by copy through the program's one door (ADR-0018, "For the host": `read` and `write`): a `Buffer` is
  copied into the process's memory for a call and the answer copied out, since a browser's APIs refuse a view of
  shared memory. A `Buffer` is never placed in the process's memory.
- **The kernel's calls.** OpenSSL's randomness is its own seeding over `getrandom`, its clock `clock_gettime`, its
  configuration file and its modules the process's files, each the kernel's call through `libc.so`, as a Linux
  process's OpenSSL makes them. The process's OpenSSL is started as Node starts it (`src/node.cc:1183-1266`: the
  configuration file `OPENSSL_CONF` names, else OpenSSL's default under OPENSSLDIR, its `nodejs_conf` section) and
  InitCryptoOnce, at the bindings' first use, where Node starts it before the environment: the engine's options are
  parsed in the realm, and no OpenSSL call comes before. The engine's option table carries none of
  `--openssl-config`, `--openssl-shared-config`, `--openssl-legacy-provider` and `--secure-heap`, so OpenSSL starts
  as Node's does when none is given.
- **A realm the host gives no `node` program has no OpenSSL**, as a Node built without it: `process.versions.openssl`
  answers none, so Node's `https` and `tls` refuse with `ERR_NO_CRYPTO` (`assertCrypto`), the `constants` binding's
  `crypto` group is the empty one such a Node defines, and a binding over OpenSSL answers that the realm has no
  program.

### 3. The export layer is Node's C++ with its V8 half removed

The `node` program's `native/node/crypto_util.cc`, `crypto_context.cc`, `crypto_cipher.cc`, `crypto_tls.cc`,
`crypto_x509.cc` and `node_constants.cc` export flat C functions (`tabnode_*`) whose bodies are the OpenSSL half of
Node's files of those names, line for line where the C++ is OpenSSL, each function naming the lines it carries; the V8
half (argument unwrapping, `Local<Object>` results, `MakeCallback`) is the bindings' TypeScript over
`src/node-lib/binding/openssl.ts`. Where ncrypto already has the code (`X509View`, `SSLPointer`, `BIOPointer`,
`CSPRNG`, the cipher and curve lists), the glue calls ncrypto. The certificate half, Node's `X509ToObject` and the
issuer walk of `GetPeerCert` (`crypto_x509.cc:611-855`, `crypto_common.cc:80-171`), is carried the same way, so
`getPeerCertificate()` answers the object `tls.checkServerIdentity` reads. Errors come back as OpenSSL's error queue,
read by the binding into Node's own error shape (`ThrowCryptoError`: the message is `ERR_error_string_n`'s, with
`library`, `reason` and `code`). Node's crypto constants are `DefineCryptoConstants` compiled into the program
against the OpenSSL it links (`node_constants.cc:866-1091`, extracted by the build), as Node compiles them into its
binary; `--tls-cipher-list` is Node's `DEFAULT_CIPHER_LIST_CORE` from the same source.

### 4. TLS: Node's own JavaScript over `tls_wrap` and `SecureContext` bindings on OpenSSL

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
  them; OpenSSL reaches them through the program's `tls_*` imports (`host:tabnode`, ADR-0018 "For the host"),
  synchronously, inside the `SSL_*` call that raised them, as in Node. Where Node defers to `SetImmediate` (a write
  the underlying stream finished synchronously, `EncOut` inside `DoWrite`), the binding defers to its binding turn, as
  the engine's stream bindings do.
- **`internalBinding('crypto')`** (`src/node-lib/binding/crypto.ts`) is what `tls` reaches of it: `SecureContext`
  (an `SSL_CTX` in the process's memory, initialised as `SecureContext::Init`), the root-certificate calls and
  `getSSLCiphers`, beside the rest of Node's crypto binding (§5). An error Node throws from C++ is made as its
  `THROW_ERR_*` makes it, the message as given with its `code`. The binding's `crypto` constants group is §3's; the
  options table answers Node's TLS options.
- **A context lives as Node's does.** A `SecureContext`'s `SSL_CTX` reference is released by `close()` or when the
  object is collected (a `FinalizationRegistry`), and a connection holding the context keeps the `SSL_CTX`, whose own
  ex_data owns the context's ticket keys, so a connection never outlives what its callbacks read.
- **`internalBinding('js_stream')`** is Node's `JSStream`, which Node's own `JSStreamSocket` drives (ADR-0013 §2).
- **The root store is the image's bundle plus `NODE_EXTRA_CA_CERTS`, as Node's `--use-openssl-ca` makes it.** The
  store a client verifies against is `/etc/ssl/certs/ca-certificates.crt` with the file `NODE_EXTRA_CA_CERTS` names,
  read through the process's files once for the process, and the options table answers `--use-openssl-ca`
  true, so `tls.getCACertificates('default')` agrees with it. *Why:* an image lays its World's CA in that bundle, so
  a World twin's certificate verifies as the image's own programs verify it; Node's default, its bundled store
  (`getBundledRootCertificates()`, compiled into the program), would refuse every twin. Node's default as a realm's
  roots is browser-substrate ROADMAP's "96's Node bundled root store", a named difference until then.
  `tls.setDefaultCACertificates()` replaces the store as Node's `ResetRootCertStore` does.
- **`getPeerX509Certificate()` and `getX509Certificate()` are Node's `X509Certificate`.** `internal/tls/wrap.js`
  wraps the binding's X509Certificate handle in `internal/crypto/x509`'s `InternalX509Certificate`, Node's own file
  (§5): the peer's certificate, its issuer the next of the peer's chain, as `X509Certificate::GetPeerCert` makes it.
  `getPeerCertificate()` is Node's `X509ToObject` and `GetPeerCert` (§3).
- **`TREE_TLS` is retired, a minor release.** The package no longer exports `TREE_TLS` or its types
  (`src/index.ts`): an exported-surface change, which RELEASING.md makes a minor release. *Why:* a process's TLS is
  now the library inside it, as a Linux process's is, so a host has nothing to offer; browser-substrate's Linux Node
  program offered none, and nothing of the substrate imports it.
- **The page bridge's TLS ports** are found from the listener itself: a port whose listening handle's owner is a
  `net.Server` holding `_sharedCreds`, the SecureContext Node's `tls.Server` keeps, answers TLS (`listensWithTls`).
- **Refused by name, each an open defect, not a platform limit:** a server's session resumption events
  (`resumeSession`, `newSession`: Node's ClientHello parser is not carried), PSK, OCSP stapling (`requestOCSP`,
  `OCSPRequest`), `enableTrace`/`--trace-tls`, `pfx`, certificate compression (the binding's half not yet
  carried), `getSharedSigalgs()`. Engines are refused by Node's own `ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED`,
  the build having none.
- **What stays the engine's:** the loop's dispatch. The wrap's callbacks run on the realm's loop as every other
  binding's do (ADR-0003); the microtask drain is the V8 glue's (browser-substrate ADR-0218 §3).

### 5. `crypto` is Node's own, with the program's OpenSSL

Node's `lib/crypto.js` and `lib/internal/crypto/*`, its `KeyObject` and `X509Certificate` among them, run unchanged
over the `crypto` binding (ADR-0018, item 7 of its order), each of whose calls is answered by the engine device (the
browser's WebCrypto, `/dev/engine`) or by the OpenSSL in the program through its glue of §3, as ADR-0018 §5
routes it. `require('crypto')`, `node:crypto` and `globalThis.crypto` are Node's; a realm with no `node` program has
no OpenSSL and no `crypto` binding, as a Node built without it.

### 6. Measured as ADR-0021 orders

Each step is a move from the engine's own module to Node's file, measured before and after by Node's own
`test/parallel/test-tls-*`, `test-https-*` and `test-crypto-*` through `scripts/node-tests.mjs`, when a measurement
is asked for. `process.versions.openssl` names the OpenSSL that runs, read from the program as Node's
GetOpenSSLVersion reads it (`3.5.8`), and the other `process.versions` entries name what runs (browser-substrate
ADR-0218 §3).

## Where the evidence stops

- **Run in the tab on 2026-11-10, over the earlier module this record's §1 replaced** (Chrome, browser-substrate's
  fast-try door, the `small` image), a `tls.createServer`/`https.createServer` on 127.0.0.1:8443 with a self-signed EC
  certificate and a client over a kernel TCP connection: with `ca`, `hello over TLSv1.3 authorized: true cipher:
  TLS_AES_256_GCM_SHA384`; with none, `DEPTH_ZERO_SELF_SIGNED_CERT`; with `rejectUnauthorized: false`, authorized
  false; `https.get` with `ca`, status 200.
- The cost of wasm against native crypto is not measured: WebCrypto and the browser's TLS run native, and WebAssembly
  has no AES or SHA instructions. ADR-0218 §0 makes speed the objective, so the asynchronous WebCrypto answers are
  not retired before that number is read.
