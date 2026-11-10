#!/bin/bash
# Builds src/node-lib/binding/node-deps-wasm.ts: node-deps.wasm, the one module of Node's own C libraries that never
# reach the kernel (ADR-0016 §1), from Node v24.21.0's source tarball, compiled by wasi-sdk 34.0 (the release
# ADR-0009 §3 pins) to a wasm32-wasip1 reactor with a memory of its own. Every input is pinned by digest.
# Today the module holds OpenSSL 3.5.8 (deps/openssl/openssl), ncrypto (deps/ncrypto) and the export layer
# (scripts/node-deps/tabnode_deps.cc). OpenSSL's notice and the linked runtime's are in THIRD-PARTY-NOTICES.md.
# Usage: scripts/build-node-deps-wasm.sh
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo/src/node-lib/binding/node-deps-wasm.ts"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
fetch() { curl -sfL -o "$2" "$1"; echo "$3  $2" | shasum -a 256 -c - >/dev/null; }
fetch https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz node.tar.xz \
  a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) sdk=wasi-sdk-34.0-arm64-macos; digest=9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9 ;;
  *) echo "this build pins wasi-sdk 34.0 for Darwin arm64 only; add this host's release digest" >&2; exit 1 ;;
esac
fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$sdk.tar.gz" sdk.tar.gz "$digest"
tar xzf sdk.tar.gz && rm sdk.tar.gz
node=node-v24.21.0
tar xJf node.tar.xz "$node/deps/openssl/openssl" "$node/deps/ncrypto" "$node/src/node_root_certs.h" \
  "$node/src/node_constants.cc" "$node/src/node_constants.h" && rm node.tar.xz
# Node's crypto constants, compiled as Node writes them: the body of DefineCryptoConstants
# (node_constants.cc:866-1091) and DEFAULT_CIPHER_LIST_CORE (node_constants.h:52-76).
mkdir -p generated
sed -n '866,1091p' "$node/src/node_constants.cc" > generated/crypto_constants_body.inc
sed -n '52,76p' "$node/src/node_constants.h" > generated/default_cipher_list.inc
SDK="$work/$sdk"
CFLAGS="--target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -O2 -D_WASI_EMULATED_SIGNAL \
-D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
export CFLAGS

# OpenSSL: Node's options (deps/openssl/config/Makefile:33-36) with no-asm, as Node's no-asm configurations have
# it, and the differences of a module with no dynamic loader, threads or sockets (ADR-0016 §1). zlib, brotli and
# zstd enter with those libraries. Node's tree is stripped of doc/; Configure reads doc/build.info, so an empty one
# is written in this scratch copy, which compiles nothing differently.
cd "$node/deps/openssl/openssl"
mkdir -p doc && : > doc/build.info
CC="$SDK/bin/clang" AR="$SDK/bin/llvm-ar" RANLIB="$SDK/bin/llvm-ranlib" CONFIGURE_CHECKER_WARN=1 \
  perl ./Configure linux-generic32 no-tests no-shared no-afalgeng enable-ssl-trace no-asm \
  no-dso no-threads no-sock no-async no-secure-memory no-ui-console no-apps no-docs no-zlib no-brotli no-zstd \
  >/dev/null
make -j"$(sysctl -n hw.ncpu)" build_libs >/dev/null
openssl="$PWD"
cd "$work"

cxx() { "$SDK/bin/clang++" $CFLAGS -std=c++20 -fno-exceptions -I"$openssl/include" -I"$node/deps/ncrypto" "$@"; }
cxx -c "$node/deps/ncrypto/ncrypto.cc" -o ncrypto.o
cxx -I"$node/src" -I"$work/generated" -c "$repo/scripts/node-deps/tabnode_deps.cc" -o tabnode_deps.o
cxx -mexec-model=reactor -Wl,--strip-all -o node-deps.wasm tabnode_deps.o ncrypto.o \
  "$openssl/libssl.a" "$openssl/libcrypto.a" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid

bytes=$(wc -c < node-deps.wasm | tr -d ' ')
sum=$(shasum -a 256 node-deps.wasm | cut -d' ' -f1)
{
  echo "/**"
  echo " * node-deps.wasm, Node's own C libraries as one module (ADR-0016). Built by \`scripts/build-node-deps-wasm.sh\`"
  echo " * from Node v24.21.0's source tarball: OpenSSL 3.5.8 (\`deps/openssl/openssl\`), ncrypto (\`deps/ncrypto\`) and"
  echo " * the export layer (\`scripts/node-deps/tabnode_deps.cc\`), with wasi-sdk 34.0. Regenerate it with that script;"
  echo " * do not edit it."
  echo " *"
  echo " *   bytes:   $bytes"
  echo " *   sha256:  $sum"
  echo " *   license: Apache-2.0 (OpenSSL), MIT (Node.js, ncrypto); notices in THIRD-PARTY-NOTICES.md"
  echo " *   runtime: wasi-libc, libc++, libc++abi, compiler-rt builtins; THIRD-PARTY-NOTICES.md"
  echo " */"
  # One string literal, not a concatenation of lines: a bundler folds `'…' + '…'` pairwise, and over a module of
  # this size (40,000 lines) that folding allocates the growing prefix at each step, quadratic in the module's length
  # (an esbuild service reached 13.5 GB on 2026-11-10). One literal parses in one pass.
  echo "export const NODE_DEPS_WASM_BASE64 ="
  printf "  '%s';\n" "$(base64 -i node-deps.wasm | tr -d '\n')"
} > "$out"
echo "$out: $bytes bytes, sha256 $sum"
