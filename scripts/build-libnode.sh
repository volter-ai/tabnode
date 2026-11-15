#!/bin/bash
# Builds `node` and `libnode.so` (ADR-0018 §1, §2): Node's start, the loop's own handles, the engine's descriptor
# waits and the fs binding's C over uv_fs_* (native/node, item 6) as a WALI program, linked position-independent
# against `libnode.so` and `libc.so`; and
# `libnode.so`, the one shared library of Node's C, which holds libuv today: the 35 sources libuv's CMakeLists.txt
# compiles on Linux (its uv_sources, the unix and Linux lists and their defines), from Node v24.21.0's deps/uv (libuv
# 1.52.1), unchanged. Both are compiled by browser-substrate's prepared native SDK with its Linux headers, whose
# compile wrapper adds WebAssembly exception handling and whose link wrapper makes a program PIE with the run path
# /opt/programs/lib, where the machine places `libc.so` and this library beside it.
# Usage: scripts/build-libnode.sh <native SDK> <node-v24.21.0.tar.gz> <out directory>
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
sdk="$(cd "$1" && pwd)"
tarball="$2"
out="$3"
echo "622424efb5dc0c26c93fbb619ff10737ee289c605b837c88778e186925d82777  $tarball" | shasum -a 256 -c - >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node=node-v24.21.0
tar xzf "$tarball" -C "$work" "$node/deps/uv"
uv="$work/$node/deps/uv"
cc="$sdk/bin/cc"
# libuv includes Linux's own headers (linux/errqueue.h, linux/if_packet.h), the SDK's beside musl's.
flags=(-fPIC -pthread -matomics -mbulk-memory -O2 -idirafter "$sdk/linux-headers/usr/include")
# deps/uv/CMakeLists.txt: uv_sources (175-187), the unix list and its defines (229-253), proctitle (282-284) and
# Linux's (327-335).
defines=(-D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -D_GNU_SOURCE -D_POSIX_C_SOURCE=200112)
sources=(fs-poll idna inet random strscpy strtok thread-common threadpool timer uv-common uv-data-getter-setters version
  unix/async unix/core unix/dl unix/fs unix/getaddrinfo unix/getnameinfo unix/loop-watcher unix/loop unix/pipe
  unix/poll unix/process unix/random-devurandom unix/signal unix/stream unix/tcp unix/thread unix/tty unix/udp
  unix/proctitle unix/linux unix/procfs-exepath unix/random-getrandom unix/random-sysctl-linux)
objects=()
for source in "${sources[@]}"; do
  object="$work/uv-${source//\//-}.o"
  "$cc" "${flags[@]}" "${defines[@]}" -I"$uv/include" -I"$uv/src" -c "$uv/src/$source.c" -o "$object" &
  objects+=("$object")
done
wait
mkdir -p "$out"
"$cc" -shared -pthread -Wl,--soname=libnode.so -o "$out/libnode.so" "${objects[@]}"
for source in node_main env poll fs fs_cp fs_event; do
  "$cc" "${flags[@]}" -I"$uv/include" -c "$repo/native/node/$source.c" -o "$work/$source.o"
done
"$cc" -pthread -o "$out/node" "$work/node_main.o" "$work/env.o" "$work/poll.o" "$work/fs.o" "$work/fs_cp.o" \
  "$work/fs_event.o" -L"$out" -lnode
