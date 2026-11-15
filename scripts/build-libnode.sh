#!/bin/bash
# Builds `node` and `libnode.so` (ADR-0018 §1, §2, §3, item 7). `libnode.so` is the one shared library of Node's C:
# libuv, OpenSSL 3.5.8 and ncrypto. `node` is a WALI program linked position-independent against it and `libc.so`:
# Node's start and its standard streams' start and end, the loop's own handles, the engine's descriptor waits and the
# bindings' glue over libuv, OpenSSL and ncrypto (native/node: one HandleWrap, the stream, TCP, pipe, TTY and UDP
# wraps, process_wrap, spawn_sync, fs over uv_fs_*, and the crypto and tls_wrap bindings' OpenSSL half, as Node's
# src/*_wrap.cc, spawn_sync.cc, node_file.cc, node_dir.cc, fs_event_wrap.cc, node_constants.cc and src/crypto/*.cc).
# Every compile is browser-substrate's prepared native SDK with its Linux headers, whose compile wrapper adds
# WebAssembly exception handling and whose link wrapper makes a program PIE with the run path /opt/programs/lib, where
# the machine places `libc.so` and this library beside it.
#
# libuv is libuv's own source at a267f5688b (2026-10-16, "unix,process: don't raise SIGCHLD from posix_spawn probe",
# #5317; its version.h says 1.53.1-dev), not Node v24.21.0's deps/uv (libuv 1.52.1), as ADR-0018's evidence says:
# 1.52.1 spawns by fork() then exec on Linux and a Node process has no fork; a267f5688b spawns by musl's posix_spawn
# after a probe of clone(CLONE_VM|CLONE_VFORK) with no termination signal. Its 35 Linux sources, as libuv's
# CMakeLists.txt compiles them on Linux, unchanged. The archive is GitHub's of that commit, pinned by its SHA-256:
#   https://github.com/libuv/libuv/archive/a267f5688be25e8d4628e296245a041adc2ca072.tar.gz
#
# OpenSSL and ncrypto are Node v24.21.0's deps/openssl/openssl (OpenSSL 3.5.8) and deps/ncrypto, from Node's release
# archive, pinned by the SHA-256 Node's SHASUMS256.txt gives it:
#   https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.gz
# OpenSSL is configured with Node's options (deps/openssl/config/Makefile:33-36) and no-asm, as Node's no-asm
# configurations have it, and compiled with Node's defines (deps/openssl/openssl.gyp, openssl_common.gypi, and
# common.gypi's for a shared libnode), its legacy provider built in as Node's libopenssl holds it. Each difference is
# named where it is made below (ADR-0016 §1).
#
# ncrypto, Node's crypto glue and every other C++ here use the WALI SDK's one C++ runtime (browser-substrate
# ADR-0231 §1): libc++ and libc++abi, position-independent, from the side-module toolchain, whose include/c++/v1,
# lib/libc++.a and lib/libc++abi.a this script reads. Each module links what it uses of it, as a side module does
# (ADR-0231 §3).
#
# Usage: scripts/build-libnode.sh <native SDK> <side-module toolchain> \
#   <libuv-a267f5688be25e8d4628e296245a041adc2ca072.tar.gz> <node-v24.21.0.tar.gz> <out directory>
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
sdk="$(cd "$1" && pwd)"
cxxrt="$(cd "$2" && pwd)"
uv_archive="$3"
node_archive="$4"
out="$5"
echo "02d51895eb7a5fbeb283f3f2a237307987f4c114fb8ba947c7d80c9d5f8ca0af  $uv_archive" | shasum -a 256 -c - >/dev/null
echo "622424efb5dc0c26c93fbb619ff10737ee289c605b837c88778e186925d82777  $node_archive" | shasum -a 256 -c - >/dev/null
for runtime in include/c++/v1/__config lib/libc++.a lib/libc++abi.a; do
  [ -f "$cxxrt/$runtime" ] || { echo "$cxxrt is not the side-module toolchain: it has no $runtime" >&2; exit 1; }
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jobs=$(getconf _NPROCESSORS_ONLN)
# Compiles run in parallel; `finish` waits for each and fails where any did.
pids=()
finish() { local pid; for pid in "${pids[@]}"; do wait "$pid"; done; pids=(); }

libuv=libuv-a267f5688be25e8d4628e296245a041adc2ca072
tar xzf "$uv_archive" -C "$work" "$libuv/include" "$libuv/src"
uv="$work/$libuv"
node=node-v24.21.0
tar xzf "$node_archive" -C "$work" "$node/deps/openssl/openssl" "$node/deps/ncrypto" "$node/src/node_root_certs.h" \
  "$node/src/node_constants.cc" "$node/src/node_constants.h"
openssl="$work/$node/deps/openssl/openssl"
ncrypto="$work/$node/deps/ncrypto"
cc="$sdk/bin/cc"
cxx="$sdk/bin/cxx"
# libuv and OpenSSL include Linux's own headers (linux/errqueue.h, linux/if_packet.h), the SDK's beside musl's.
flags=(-fPIC -pthread -matomics -mbulk-memory -O2 -idirafter "$sdk/linux-headers/usr/include")
# Node's C++ (common.gypi cflags_cc: -fno-rtti -fno-exceptions -std=gnu++20) over the one C++ runtime's headers.
cxxflags=(-std=gnu++20 -fno-rtti -fno-exceptions -nostdinc++ -isystem "$cxxrt/include/c++/v1")
# What a module links of the C++ runtime it uses.
cxxlibs=("$cxxrt/lib/libc++.a" "$cxxrt/lib/libc++abi.a")

# libuv's CMakeLists.txt at a267f5688b: uv_sources (175-187), the unix list and its defines (230-258), proctitle
# (284-286) and Linux's (328-336).
defines=(-D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -D_GNU_SOURCE -D_POSIX_C_SOURCE=200112)
sources=(fs-poll idna inet random strscpy strtok thread-common threadpool timer uv-common uv-data-getter-setters version
  unix/async unix/core unix/dl unix/fs unix/getaddrinfo unix/getnameinfo unix/loop-watcher unix/loop unix/pipe
  unix/poll unix/process unix/random-devurandom unix/signal unix/stream unix/tcp unix/thread unix/tty unix/udp
  unix/proctitle unix/linux unix/procfs-exepath unix/random-getrandom unix/random-sysctl-linux)
objects=()
for source in "${sources[@]}"; do
  object="$work/uv-${source//\//-}.o"
  "$cc" "${flags[@]}" "${defines[@]}" -I"$uv/include" -I"$uv/src" -c "$uv/src/$source.c" -o "$object" &
  pids+=($!)
  objects+=("$object")
done
finish

# OpenSSL 3.5.8 with Node's Configure options (no-tests no-shared no-afalgeng enable-ssl-trace enable-fips) and no-asm.
# Differences from Node's, each named:
# - linux-generic64, where Node configures its host's target: wasm32-linux-muslwali has a 64-bit `long` and 32-bit
#   pointers, OpenSSL's SIXTY_FOUR_BIT_LONG, the target browser-substrate's own OpenSSL recipe takes
#   (programs/native-providers/openssl).
# - no-zlib no-brotli no-zstd, where Node's has zlib, enable-brotli and enable-zstd over its own deps/zlib, deps/brotli
#   and deps/zstd for RFC 8879 certificate compression: those libraries are not yet in libnode.so (ADR-0018 §1), so
#   getCertificateCompressionAlgorithms() answers the empty list this OpenSSL has.
# - --prefix=/usr --libdir=lib --openssldir=/etc/ssl: OPENSSLDIR is Node's Linux "/etc/ssl" (openssl_common.gypi);
#   MODULESDIR is /usr/lib/ossl-modules, the image's, where Node's names its own build tree; ENGINESDIR is
#   /usr/lib/engines-3 where Node's gyp says /dev/null, and no code reads it, since no-shared configures no dynamic
#   engine, as Node's does.
# Node's tree is stripped of doc/; Configure reads doc/build.info, so an empty one is written in this scratch copy,
# which compiles nothing differently. Node's defines for the library (openssl.gyp: OPENSSL_NO_HW,
# OPENSSL_API_COMPAT=0x10100001L, STATIC_LEGACY; openssl_common.gypi: TERMIOS; common.gypi: OPENSSL_THREADS, and no
# OPENSSL_NO_PINSHARED, as for a shared libnode) are Configure's -D arguments, so every compile has them.
(
  cd "$openssl"
  mkdir -p doc && : > doc/build.info
  CC="$cc" AR="$sdk/bin/ar" RANLIB="$sdk/bin/ranlib" CFLAGS="${flags[*]/-O2/-O3}" CONFIGURE_CHECKER_WARN=1 \
    "$sdk/bin/perl" ./Configure linux-generic64 no-tests no-shared no-afalgeng enable-ssl-trace enable-fips no-asm \
    no-zlib no-brotli no-zstd --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
    -DOPENSSL_NO_HW -DOPENSSL_API_COMPAT=0x10100001L -DSTATIC_LEGACY -DTERMIOS -DOPENSSL_THREADS >/dev/null
  # libcrypto and libssl, and the legacy provider as Node's libopenssl builds it in: its implementations
  # (providers/liblegacy.a) and its entry (legacyprov.c), whose STATIC_LEGACY form is ossl_legacy_provider_init, the
  # built-in provider crypto/provider_predefined.c names.
  "$sdk/bin/make" -j"$jobs" build_libs providers/liblegacy.a providers/legacy-dso-legacyprov.o >/dev/null
)

# ncrypto (deps/ncrypto/ncrypto.gyp): ncrypto.cc with its strict defines, and engine.cc as its ncrypto_engine target.
ncdefines=(-DNCRYPTO_BSSL_LIBDECREPIT_MISSING=1 -DOPENSSL_API_COMPAT=30000)
"$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_NO_DEPRECATED -I"$openssl/include" -I"$ncrypto" \
  -c "$ncrypto/ncrypto.cc" -o "$work/ncrypto.o" &
pids+=($!)
"$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_SUPPRESS_DEPRECATED -DNCRYPTO_ENGINE_COMPAT=1 \
  -I"$openssl/include" -I"$ncrypto" -c "$ncrypto/engine.cc" -o "$work/ncrypto-engine.o" &
pids+=($!)
finish

mkdir -p "$out"
# libnode.so holds the whole of libuv, OpenSSL (libssl and libcrypto) and ncrypto, as gyp links every static dependency
# of Node's shared library whole (node.gyp:1141), so the program and an addon find all of each in the image. The legacy
# provider's entry is linked with them, and its implementations come from providers/liblegacy.a as the entry needs
# them: Node's source list holds each file once where the default and the legacy provider share it
# (cipher_tdes_common.c, ripemd_prov.c, prov_running.c), and liblegacy.a has its own copy of those, which libcrypto
# already defines.
"$cc" -shared -pthread -Wl,--soname=libnode.so -o "$out/libnode.so" "${objects[@]}" \
  "$work/ncrypto.o" "$work/ncrypto-engine.o" "$openssl/providers/legacy-dso-legacyprov.o" \
  -Wl,--whole-archive "$openssl/libssl.a" "$openssl/libcrypto.a" -Wl,--no-whole-archive \
  "$openssl/providers/liblegacy.a" "${cxxlibs[@]}"

# Node's crypto constants, compiled as Node writes them: the headers and fallbacks node_constants.cc includes under
# HAVE_OPENSSL (39-95), the body of DefineCryptoConstants (866-1091) and DEFAULT_CIPHER_LIST_CORE (node_constants.h
# 52-76).
mkdir -p "$work/generated"
sed -n '39,95p' "$work/$node/src/node_constants.cc" > "$work/generated/crypto_constants_prelude.inc"
sed -n '866,1091p' "$work/$node/src/node_constants.cc" > "$work/generated/crypto_constants_body.inc"
sed -n '52,76p' "$work/$node/src/node_constants.h" > "$work/generated/default_cipher_list.inc"

# native/node: Node's start (node_main) and its standard streams' (stdio), its Environment's handles (env), the
# engine's descriptor waits (poll), and the bindings' C, each over the Node source it names (memory, signo,
# handle_wrap, stream_wrap, tcp_wrap, pipe_wrap, tty_wrap, udp_wrap, process_wrap, spawn_sync, fs, fs_cp, fs_event),
# the engine device's descriptor (engine_device); and the crypto and tls_wrap bindings' C++ over ncrypto and OpenSSL
# (crypto_util, crypto_context, crypto_cipher, crypto_tls, crypto_x509, crypto_keys, crypto_rsa, crypto_dsa,
# crypto_dh, crypto_ec, crypto_pqc, crypto_hash, crypto_hmac, crypto_random, crypto_sig, node_constants), with the defines ncrypto
# gives its dependents (ncrypto.gyp).
program=()
for source in node_main stdio env poll memory signo handle_wrap stream_wrap tcp_wrap pipe_wrap tty_wrap udp_wrap \
  process_wrap spawn_sync fs fs_cp fs_event engine_device; do
  "$cc" "${flags[@]}" -D_GNU_SOURCE -I"$uv/include" -c "$repo/native/node/$source.c" -o "$work/$source.o" &
  pids+=($!)
  program+=("$work/$source.o")
done
for source in crypto_util crypto_context crypto_cipher crypto_tls crypto_x509 crypto_keys crypto_rsa crypto_dsa crypto_dh \
  crypto_ec crypto_pqc crypto_hash crypto_hmac crypto_random crypto_sig node_constants; do
  "$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_NO_DEPRECATED -D_GNU_SOURCE -I"$uv/include" \
    -I"$openssl/include" -I"$ncrypto" -I"$work/generated" -I"$work/$node/src" \
    -c "$repo/native/node/$source.cc" -o "$work/$source.o" &
  pids+=($!)
  program+=("$work/$source.o")
done
finish
"$cc" -pthread -o "$out/node" "${program[@]}" -L"$out" -lnode "${cxxlibs[@]}"
