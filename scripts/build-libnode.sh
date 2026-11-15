#!/bin/bash
# Builds `node` and `libnode.so` (ADR-0018 §1, §2, §3): Node's start and its standard streams' start and end, the
# loop's own handles, the engine's descriptor waits and the bindings' C over libuv (native/node: one HandleWrap, the
# stream, TCP, pipe, TTY and UDP wraps, process_wrap and spawn_sync, as Node's src/*_wrap.cc and spawn_sync.cc) as a
# WALI program, linked position-independent against `libnode.so` and `libc.so`; and `libnode.so`, the one shared
# library of Node's C, which holds libuv today: the 35 sources libuv's CMakeLists.txt compiles on Linux (its
# uv_sources, the unix and Linux lists and their defines), unchanged. Both are compiled by browser-substrate's prepared
# native SDK with its Linux headers, whose compile wrapper adds WebAssembly exception handling and whose link wrapper
# makes a program PIE with the run path /opt/programs/lib, where the machine places `libc.so` and this library beside
# it.
#
# libuv is libuv's own source at a267f5688b (2026-10-16, "unix,process: don't raise SIGCHLD from posix_spawn probe",
# #5317; its version.h says 1.53.1-dev), not Node v24.21.0's deps/uv (libuv 1.52.1), as ADR-0018's evidence says:
# 1.52.1 spawns by fork() then exec on Linux and a Node process has no fork; a267f5688b spawns by musl's posix_spawn
# after a probe of clone(CLONE_VM|CLONE_VFORK) with no termination signal. Its Linux sources are the same 35 files.
# The archive is GitHub's of that commit, pinned by its SHA-256:
#   https://github.com/libuv/libuv/archive/a267f5688be25e8d4628e296245a041adc2ca072.tar.gz
# Usage: scripts/build-libnode.sh <native SDK> <libuv-a267f5688be25e8d4628e296245a041adc2ca072.tar.gz> <out directory>
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
sdk="$(cd "$1" && pwd)"
archive="$2"
out="$3"
echo "02d51895eb7a5fbeb283f3f2a237307987f4c114fb8ba947c7d80c9d5f8ca0af  $archive" | shasum -a 256 -c - >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
libuv=libuv-a267f5688be25e8d4628e296245a041adc2ca072
tar xzf "$archive" -C "$work" "$libuv/include" "$libuv/src"
uv="$work/$libuv"
cc="$sdk/bin/cc"
# libuv includes Linux's own headers (linux/errqueue.h, linux/if_packet.h), the SDK's beside musl's.
flags=(-fPIC -pthread -matomics -mbulk-memory -O2 -idirafter "$sdk/linux-headers/usr/include")
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
  objects+=("$object")
done
wait
mkdir -p "$out"
"$cc" -shared -pthread -Wl,--soname=libnode.so -o "$out/libnode.so" "${objects[@]}"
# native/node: Node's start (node_main) and its standard streams' (stdio), its Environment's handles (env), the
# engine's descriptor waits (poll), and the bindings' C, each over the Node source it names (memory, signo,
# handle_wrap, stream_wrap, tcp_wrap, pipe_wrap, tty_wrap, udp_wrap, process_wrap, spawn_sync).
program=()
for source in node_main stdio env poll memory signo handle_wrap stream_wrap tcp_wrap pipe_wrap tty_wrap udp_wrap \
  process_wrap spawn_sync; do
  "$cc" "${flags[@]}" -D_GNU_SOURCE -I"$uv/include" -c "$repo/native/node/$source.c" -o "$work/$source.o"
  program+=("$work/$source.o")
done
"$cc" -pthread -o "$out/node" "${program[@]}" -L"$out" -lnode
