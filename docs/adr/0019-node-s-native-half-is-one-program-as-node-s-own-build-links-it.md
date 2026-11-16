# ADR-0019: Node's native half is one program, as Node's own build links it

Status: Accepted

Amends [ADR-0018](0018-a-node-process-s-loop-is-libuv-and-its-c-libraries-are-one-wali-library.md) §1 and §2:
`libnode.so` goes, and its C is the program's.

Date: 2026-11-16. Served: browser-substrate ADR-0236 step 4 ("A library the reference distribution ships shared is
a shared library here") and ADR-0238 (exec of a dynamic program, its C++ runtime).

## Context

- **The reference distribution.** Rallly runs on `node:24-slim` (`apps/web/Dockerfile`, `FROM node:24-slim`). Its
  `/usr/local/bin/node` is one executable, and `ldd` lists only `libdl`, `libstdc++`, `libm`, `libgcc_s`,
  `libpthread` and `libc`. libuv, OpenSSL, zlib, brotli, zstd, llhttp, nghttp2, Ada and simdutf are in the
  executable, and the image has no `libnode.so`.
- **Node's own build** (v24.21.0) links the executable from `node_base`, whole (`node.gyp:635-657`,
  `-Wl,--whole-archive`), with `-rdynamic` (`common.gypi:586`), so an addon `dlopen` binds to the executable's own
  `napi_*`, `uv_*` and OpenSSL. A shared `libnode` is the `--shared` configuration, "for embedding node in another
  project. (This mode is not officially supported for regular applications)" (`configure.py:1034-1038`,
  `node_shared`).
- **ADR-0018 §1's reason** for `libnode.so` was that an addon `dlopen`s into the same image, with one libc and one
  `malloc`. On the machine, `libc.so` is the process's one libc (browser-substrate ADR-0236 step 4), so the reason
  holds for one program that exports its symbols, as it does for Node's.

## Decision

### 1. `/usr/bin/node` is one WALI program

Node's native half is linked into the program as Node's default build links it: libuv, OpenSSL and ncrypto, llhttp,
Ada, zlib, brotli, zstd, nghttp2, simdutf, merve and Node's glue (ADR-0018 §3), each with Node's configuration. The
program needs `libc.so` and the SDK's C++ runtime alone (browser-substrate ADR-0238 §4), and links through the SDK's
`c++`, which adds that runtime. No build names a runtime library or a tag object.

### 2. It exports what Node's executable exports

The program is linked with `-rdynamic`, as `common.gypi` links Node's. An addon `dlopen`ed into the process binds
its `napi_*`, `uv_*` and OpenSSL imports to the program's definitions, with one libc and one `malloc` (ADR-0018 §1's
reason, unchanged).

### 3. The engine binds the program's exports

The realm attaches to the program's instance. What ADR-0018 calls `libnode`'s exports are the program's, and the
binding's name for them says so.

### 4. A dependency reads Linux

A dependency compiled into the program is compiled as Node's Linux build compiles it. Where its source reads
`__wasm__` as "a JavaScript host", that is a platform test, and it is corrected as browser-substrate ADR-0238 §5
corrects it, never by undefining `__wasm__` for a list of files.

## Where the evidence stops

- Read: `node:24-slim`'s `ldd`, the lines of Node v24.21.0's `node.gyp`, `common.gypi` and `configure.py` cited
  above, and ADR-0018 §1.
- Not read: Node's executable's dynamic symbol table, which says exactly what `-rdynamic` exports.

## Consequences

- `libnode.so`, its soname and its place in the image's run path go. `scripts/build-libnode.sh` links one program.
- ADR-0018's sentences that name `libnode.so` as a module read as the program's C.
