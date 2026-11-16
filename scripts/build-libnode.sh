#!/bin/bash
# Builds `node` and `libnode.so` (ADR-0018 §1, §2, §3, items 7, 8 and 10). `libnode.so` is the one shared library of
# Node's C: libuv, OpenSSL 3.5.8 and ncrypto, zlib, brotli 1.2.0, zstd 1.5.7, llhttp 9.4.3, merve, simdutf and simdjson. `node` is a WALI program linked position-independent against it and `libc.so`:
# Node's start and its standard streams' and signals' start and end, the loop's own handles, the engine's descriptor
# waits and the bindings' glue over libuv, OpenSSL and ncrypto (native/node: one HandleWrap, the stream, TCP, pipe, TTY
# and UDP wraps, process_wrap, spawn_sync, signal_wrap, MessagePort, fs over uv_fs_*, and the crypto and tls_wrap bindings' OpenSSL
# half, as Node's src/*_wrap.cc, spawn_sync.cc, node_file.cc, node_dir.cc, fs_event_wrap.cc, node_constants.cc, node.cc's start, node_options.cc and
# src/crypto/*.cc). Every compile is browser-substrate's prepared native SDK with its Linux headers, whose compile
# wrapper adds WebAssembly exception handling and whose link wrapper makes a program PIE with the run path
# /opt/programs/lib, where the machine places `libc.so` and this library beside it.
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
# ncrypto, Node's crypto glue and every other C++ here use the process's one C++ runtime (browser-substrate
# ADR-0231 §1): the side-module toolchain's libc++.so, libc++ and libc++abi whole, which node and libnode.so both link
# shared, as Linux's node links libstdc++.so.6, so the process holds one copy of libc++'s state (its locale ids,
# facets and guards). Each module also links the toolchain's position-independent libunwind.a, its symbols hidden,
# because the landing-pad context a module's catches use is that module's own; it is given before the SDK's own
# -lunwind, whose sysroot archive is not position-independent (browser-substrate ADR-0236 step 4). The unwinder imports
# the C++ exception tag, and the program defines and exports it once, linking lib/cpp-exception-tag.o, so the process
# has one tag that libnode.so and libc++.so import (browser-substrate ADR-0236 hole 7).
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
for runtime in include/c++/v1/__config lib/libc++.so lib/libunwind.a lib/cpp-exception-tag.o; do
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
  "$node/src/node_constants.cc" "$node/src/node_constants.h" "$node/src/tracing/trace_event_common.h" \
  "$node/src/node_options.cc" "$node/src/node_options.h" "$node/src/node_options-inl.h" "$node/src/node.h" \
  "$node/src/node_revert.h" "$node/src/node_version.h" "$node/src/quic/guard.h" "$node/src/large_pages/node_large_page.cc" \
  "$node/src/node_exit_code.h" "$node/src/util.h" "$node/src/util-inl.h" "$node/src/util.cc" "$node/src/debug_utils-inl.h" \
  "$node/src/node_dotenv.h" "$node/src/node_dotenv.cc" "$node/src/node_config_file.h" "$node/src/node_config_file.cc" \
  "$node/src/node_task_runner.h" "$node/src/node_task_runner.cc"
openssl="$work/$node/deps/openssl/openssl"
ncrypto="$work/$node/deps/ncrypto"
cc="$sdk/bin/cc"
cxx="$sdk/bin/cxx"
# libuv and OpenSSL include Linux's own headers (linux/errqueue.h, linux/if_packet.h), the SDK's beside musl's.
flags=(-fPIC -pthread -matomics -mbulk-memory -O2 -idirafter "$sdk/linux-headers/usr/include")
# Node's C++ (common.gypi cflags_cc: -fno-rtti -fno-exceptions -std=gnu++20) over the one C++ runtime's headers.
cxxflags=(-std=gnu++20 -fno-rtti -fno-exceptions -nostdinc++ -isystem "$cxxrt/include/c++/v1")
# What a module links of the C++ runtime it uses.
cxxlibs=(-L"$cxxrt/lib" -lc++ "$cxxrt/lib/libunwind.a")

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

# zlib, brotli, zstd and llhttp's sources (item 10, below), unpacked first: OpenSSL is configured over the first three.
tar xzf "$node_archive" -C "$work" "$node/deps/zlib" "$node/deps/brotli" "$node/deps/zstd" "$node/deps/llhttp" \
  "$node/deps/merve" "$node/deps/v8/third_party/simdutf" "$node/deps/simdjson" "$node/src/node_zlib.cc"
zlibsrc="$work/$node/deps/zlib"
brotlisrc="$work/$node/deps/brotli"
zstdsrc="$work/$node/deps/zstd"
llhttpsrc="$work/$node/deps/llhttp"
mervesrc="$work/$node/deps/merve"
simdutfsrc="$work/$node/deps/v8/third_party/simdutf"
simdjsonsrc="$work/$node/deps/simdjson"

# OpenSSL 3.5.8 with Node's Configure options (no-tests no-shared no-afalgeng enable-ssl-trace enable-fips, and zlib,
# enable-brotli and enable-zstd over Node's own deps/zlib, deps/brotli and deps/zstd for RFC 8879 certificate
# compression, their headers the ones libnode.so's copies are built from) and no-asm.
# Differences from Node's, each named:
# - linux-generic64, where Node configures its host's target: wasm32-linux-muslwali has a 64-bit `long` and 32-bit
#   pointers, OpenSSL's SIXTY_FOUR_BIT_LONG, the target browser-substrate's own OpenSSL recipe takes
#   (programs/native-providers/openssl).
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
    zlib --with-zlib-include="$zlibsrc" enable-brotli --with-brotli-include="$brotlisrc/c/include" \
    enable-zstd --with-zstd-include="$zstdsrc/lib" --prefix=/usr --libdir=lib --openssldir=/etc/ssl \
    -DOPENSSL_NO_HW -DOPENSSL_API_COMPAT=0x10100001L -DSTATIC_LEGACY -DTERMIOS -DOPENSSL_THREADS >/dev/null
  # libcrypto and libssl, and the legacy provider as Node's libopenssl builds it in: its implementations
  # (providers/liblegacy.a) and its entry (legacyprov.c), whose STATIC_LEGACY form is ossl_legacy_provider_init, the
  # built-in provider crypto/provider_predefined.c names.
  # A file target of OpenSSL's Makefile depends on no generated header: its build_* targets run build_generated first
  # (safestack.h, opensslv.h and the rest, made from their .in), so the legacy provider's files are made after
  # build_libs has made them, never beside it in one parallel make.
  "$sdk/bin/make" -j"$jobs" build_libs >/dev/null
  "$sdk/bin/make" -j"$jobs" providers/liblegacy.a providers/legacy-dso-legacyprov.o >/dev/null
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

# zlib, brotli, zstd and llhttp (ADR-0018 item 10): Node v24.21.0's deps/zlib (Chromium's zlib, 1.3.2.1-motley, as Node
# ships it), deps/brotli (1.2.0), deps/zstd (1.5.7) and deps/llhttp (9.4.3), from the same release archive, each
# compiled with its gyp file's sources and defines and Node's Release flags for every target (common.gypi: -O3,
# -fno-omit-frame-pointer, -pthread, _FILE_OFFSET_BITS=64, _GLIBCXX_USE_CXX11_ABI=1, __STDC_FORMAT_MACROS; its warning
# flags aside). Differences from Node's, each named:
# - zlib is zlib.gyp's target for an architecture with neither x86's nor NEON's optimizations, which wasm32 is:
#   BUILD.gn's "zlib" sources and inflate.c, CPU_NO_SIMD and HAVE_HIDDEN; none of its SIMD targets.
# - zstd's huf_decompress_amd64.S is not assembled, as Node's ZSTD_DISABLE_ASM leaves it.
# src/node_zlib.cc's DefineZlibConstants, its chunk and level bounds (74-88) and its mode enum (146-159) are extracted
# for node_constants.cc to compile, as Node's CreatePerContextProperties calls it (node_constants.cc:1357-1372).
depflags=("${flags[@]/-O2/-O3}" -fno-omit-frame-pointer -D_FILE_OFFSET_BITS=64 -D_GLIBCXX_USE_CXX11_ABI=1
  -D__STDC_FORMAT_MACROS)
deps=()
for source in adler32 compress cpu_features crc32 deflate gzclose gzlib gzread gzwrite infback inffast inftrees trees \
  uncompr zutil inflate; do
  "$cc" "${depflags[@]}" -DCPU_NO_SIMD -DHAVE_HIDDEN -I"$zlibsrc" -c "$zlibsrc/$source.c" -o "$work/zlib-$source.o" &
  pids+=($!)
  deps+=("$work/zlib-$source.o")
done
for source in common/constants common/context common/dictionary common/platform common/shared_dictionary \
  common/transform dec/bit_reader dec/decode dec/huffman dec/prefix dec/state dec/static_init \
  enc/backward_references enc/backward_references_hq enc/bit_cost enc/block_splitter enc/brotli_bit_stream \
  enc/cluster enc/command enc/compound_dictionary enc/compress_fragment enc/compress_fragment_two_pass \
  enc/dictionary_hash enc/encode enc/encoder_dict enc/entropy_encode enc/fast_log enc/histogram enc/literal_cost \
  enc/memory enc/metablock enc/static_dict enc/static_dict_lut enc/static_init enc/utf8_util; do
  object="$work/brotli-${source//\//-}.o"
  "$cc" "${depflags[@]}" -DOS_LINUX -I"$brotlisrc/c/include" -c "$brotlisrc/c/$source.c" -o "$object" &
  pids+=($!)
  deps+=("$object")
done
zstddefines=(-DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD -DZSTD_DISABLE_ASM)
for source in common/debug common/entropy_common common/fse_decompress compress/fse_compress compress/huf_compress \
  decompress/huf_decompress common/pool common/threading common/xxhash common/zstd_common common/error_private \
  compress/hist compress/zstd_compress compress/zstd_compress_literals compress/zstd_compress_sequences \
  compress/zstd_compress_superblock compress/zstd_double_fast compress/zstd_fast compress/zstd_lazy compress/zstd_ldm \
  compress/zstd_opt compress/zstd_preSplit compress/zstdmt_compress decompress/zstd_ddict decompress/zstd_decompress \
  decompress/zstd_decompress_block; do
  object="$work/zstd-${source//\//-}.o"
  "$cc" "${depflags[@]}" "${zstddefines[@]}" -I"$zstdsrc/lib" -c "$zstdsrc/lib/$source.c" -o "$object" &
  pids+=($!)
  deps+=("$object")
done
# llhttp's api.c binds, under __wasm__, the parser of a standalone module whose host is JavaScript (undici's
# llhttp.wasm): callbacks it imports from that host (wasm_on_*), llhttp_alloc and llhttp_free. libnode.so's llhttp is
# Node's for a Linux program, whose callbacks node_http_parser sets, so api.c is compiled as Node's Linux build compiles
# it, without __wasm__; llhttp.c keeps it, where it names the architecture (its SIMD over wasm_simd128.h).
for source in llhttp api http; do
  native=(); [ "$source" = api ] && native=(-U__wasm__)
  "$cc" "${depflags[@]}" ${native[@]+"${native[@]}"} -I"$llhttpsrc" -I"$llhttpsrc/include" -c "$llhttpsrc/src/$source.c" \
    -o "$work/llhttp-$source.o" &
  pids+=($!)
  deps+=("$work/llhttp-$source.o")
done
# merve (deps/merve/merve.gyp: merve.cpp, C++20, over V8's simdutf as include) and simdutf (tools/v8_gypfiles/v8.gyp's
# simdutf target: simdutf.cpp), the CommonJS export lexer internalBinding('cjs_lexer') is (ADR-0018 §7).
"$cxx" "${depflags[@]}" "${cxxflags[@]}" -I"$simdutfsrc" -c "$simdutfsrc/simdutf.cpp" -o "$work/simdutf.o" &
pids+=($!)
deps+=("$work/simdutf.o")
"$cxx" "${depflags[@]}" "${cxxflags[@]}" -I"$mervesrc" -I"$simdutfsrc" -c "$mervesrc/merve.cpp" -o "$work/merve.o" &
pids+=($!)
deps+=("$work/merve.o")
# simdjson (deps/simdjson/simdjson.gyp: simdjson.cpp), the JSON reader of Node's config file and `--run`
# (node_config_file.cc, node_task_runner.cc).
"$cxx" "${depflags[@]}" "${cxxflags[@]}" -I"$simdjsonsrc" -c "$simdjsonsrc/simdjson.cpp" -o "$work/simdjson.o" &
pids+=($!)
deps+=("$work/simdjson.o")
finish
mkdir -p "$work/generated"
{ sed -n '74,88p' "$work/$node/src/node_zlib.cc"; sed -n '146,159p' "$work/$node/src/node_zlib.cc"
  sed -n '1922,2106p' "$work/$node/src/node_zlib.cc"; } > "$work/generated/node_zlib_constants.inc"

mkdir -p "$out"
# libnode.so holds the whole of libuv, OpenSSL (libssl and libcrypto) and ncrypto, as gyp links every static dependency
# of Node's shared library whole (node.gyp:1141), so the program and an addon find all of each in the image. The legacy
# provider's entry is linked with them, and its implementations come from providers/liblegacy.a as the entry needs
# them: Node's source list holds each file once where the default and the legacy provider share it
# (cipher_tdes_common.c, ripemd_prov.c, prov_running.c), and liblegacy.a has its own copy of those, which libcrypto
# already defines.
"$cc" -shared -pthread -Wl,--soname=libnode.so -o "$out/libnode.so" "${objects[@]}" \
  "$work/ncrypto.o" "$work/ncrypto-engine.o" "$openssl/providers/legacy-dso-legacyprov.o" "${deps[@]}" \
  -Wl,--whole-archive "$openssl/libssl.a" "$openssl/libcrypto.a" -Wl,--no-whole-archive \
  "$openssl/providers/liblegacy.a" "${cxxlibs[@]}"

# Node's constants, compiled as Node writes them (native/node/node_constants.cc): the system headers and fallbacks
# node_constants.cc includes (30-113), every Define* function CreatePerContextProperties calls (126-1333), and
# node_constants.h's own definitions (30-78: EXTENSIONLESS_FORMAT_*, the RSA_PSS_SALTLEN_* fallbacks and
# DEFAULT_CIPHER_LIST_CORE); tracing/trace_event_common.h is read in Node's tree.
mkdir -p "$work/generated"
sed -n '30,113p' "$work/$node/src/node_constants.cc" > "$work/generated/node_constants_prelude.inc"
sed -n '126,1333p' "$work/$node/src/node_constants.cc" > "$work/generated/node_constants_body.inc"
sed -n '30,78p' "$work/$node/src/node_constants.h" > "$work/generated/node_constants_header.inc"

# Node's start before V8, compiled as Node writes it (native/node/node_start.cc): node.h's OptionEnvvarSettings
# (364-371), node_exit_code.h's ExitCode (7-46), util.h's ToLower, ToUpper and StringEqualNoCase (369-383) and USE and
# OnScopeLeave (611-638), util-inl.h's definitions (194-240), util.cc's ReadFileSync (264-301), debug_utils-inl.h's
# SPrintF and FPrintF (14-65, 84-200), node_options.h's structs and parser (19-699), node_options-inl.h's (12-520),
# node_options.cc's per-process options and CheckOptions (40-311), its parsers and their tables (389-1662) and its
# HandleEnvOptions and ParseNodeOptionsEnvVar (2171-2240), node_revert.h's Revert (16-78), node_large_page.cc's
# MapStaticCodeToLargePages and LargePagesError (417-462), node_dotenv.h's Dotenv (13-39) and node_dotenv.cc's
# GetDataFromArgs, ParseContent, ParsePath and AssignNodeOptionsIfAvailable (19-65, 105-350), node_config_file.h's
# ConfigReader (17-64) and node_config_file.cc (6-341), and node_task_runner.h's and node_task_runner.cc's `--run`
# (16-88, 6-373); node_version.h and quic/guard.h are read in Node's tree, and simdjson.h in deps/simdjson.
sed -n '364,371p' "$work/$node/src/node.h" > "$work/generated/node_options_envvar.inc"
sed -n '19,699p' "$work/$node/src/node_options.h" > "$work/generated/node_options_header.inc"
sed -n '12,520p' "$work/$node/src/node_options-inl.h" > "$work/generated/node_options_inl.inc"
sed -n '40,311p' "$work/$node/src/node_options.cc" > "$work/generated/node_options_cc_checks.inc"
sed -n '389,1662p' "$work/$node/src/node_options.cc" > "$work/generated/node_options_cc_parsers.inc"
sed -n '2171,2240p' "$work/$node/src/node_options.cc" > "$work/generated/node_options_cc_env.inc"
sed -n '16,78p' "$work/$node/src/node_revert.h" > "$work/generated/node_revert.inc"
sed -n '417,462p' "$work/$node/src/large_pages/node_large_page.cc" > "$work/generated/node_large_page.inc"
sed -n '7,46p' "$work/$node/src/node_exit_code.h" > "$work/generated/node_exit_code.inc"
sed -n '369,383p' "$work/$node/src/util.h" > "$work/generated/node_util_h.inc"
sed -n '611,638p' "$work/$node/src/util.h" > "$work/generated/node_util_scope.inc"
sed -n '194,240p' "$work/$node/src/util-inl.h" > "$work/generated/node_util_inl.inc"
sed -n '264,301p' "$work/$node/src/util.cc" > "$work/generated/node_util_read.inc"
sed -n '14,65p' "$work/$node/src/debug_utils-inl.h" > "$work/generated/node_debug_utils_a.inc"
sed -n '84,200p' "$work/$node/src/debug_utils-inl.h" > "$work/generated/node_debug_utils_b.inc"
sed -n '13,39p' "$work/$node/src/node_dotenv.h" > "$work/generated/node_dotenv_h.inc"
sed -n '19,65p' "$work/$node/src/node_dotenv.cc" > "$work/generated/node_dotenv_args.inc"
sed -n '105,350p' "$work/$node/src/node_dotenv.cc" > "$work/generated/node_dotenv_parse.inc"
sed -n '17,64p' "$work/$node/src/node_config_file.h" > "$work/generated/node_config_file_h.inc"
sed -n '6,341p' "$work/$node/src/node_config_file.cc" > "$work/generated/node_config_file_cc.inc"
sed -n '16,88p' "$work/$node/src/node_task_runner.h" > "$work/generated/node_task_runner_h.inc"
sed -n '6,373p' "$work/$node/src/node_task_runner.cc" > "$work/generated/node_task_runner_cc.inc"

# native/node: Node's start (node_main) and its standard streams' and signals' (stdio), its Environment's handles
# (env), the engine's descriptor waits (poll), and the bindings' C, each over the Node source it names (memory, signo,
# handle_wrap, stream_wrap, tcp_wrap, pipe_wrap, tty_wrap, udp_wrap, process_wrap, spawn_sync, signal_wrap,
# process_methods, credentials, node_env_var, uv, fs, fs_cp, fs_event, node_messaging), the engine device's descriptor (engine_device); and the crypto and
# tls_wrap bindings' C++ over ncrypto and OpenSSL, and Node's constants (crypto_util, crypto_context, crypto_cipher,
# crypto_tls, crypto_x509, crypto_keys, crypto_rsa, crypto_dsa, crypto_dh, crypto_ec, crypto_pqc, crypto_hash,
# crypto_hmac, crypto_random, crypto_sig, crypto_pbkdf2, crypto_scrypt, crypto_hkdf, crypto_keygen, crypto_aes,
# crypto_chacha20_poly1305, crypto_kmac, crypto_turboshake, crypto_argon2, crypto_kem, crypto_spkac, node_constants,
# node_start),
# with the defines ncrypto gives its dependents (ncrypto.gyp).
program=()
for source in node_main stdio env poll memory signo handle_wrap stream_wrap tcp_wrap pipe_wrap tty_wrap udp_wrap \
  process_wrap spawn_sync signal_wrap process_methods credentials node_env_var uv fs fs_cp fs_event node_messaging engine_device; do
  "$cc" "${flags[@]}" -D_GNU_SOURCE -I"$uv/include" -c "$repo/native/node/$source.c" -o "$work/$source.o" &
  pids+=($!)
  program+=("$work/$source.o")
done
for source in crypto_util crypto_context crypto_cipher crypto_tls crypto_x509 crypto_keys crypto_rsa crypto_dsa crypto_dh \
  crypto_ec crypto_pqc crypto_hash crypto_hmac crypto_random crypto_sig crypto_pbkdf2 crypto_scrypt crypto_hkdf \
  crypto_keygen crypto_aes crypto_chacha20_poly1305 crypto_kmac crypto_turboshake crypto_argon2 crypto_kem crypto_spkac \
  node_constants node_start; do
  "$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_NO_DEPRECATED -D_GNU_SOURCE -I"$uv/include" \
    -I"$openssl/include" -I"$ncrypto" -I"$work/generated" -I"$work/$node/src" -I"$zlibsrc" -I"$brotlisrc/c/include" \
    -I"$zstdsrc/lib" -I"$simdjsonsrc" -c "$repo/native/node/$source.cc" -o "$work/$source.o" &
  pids+=($!)
  program+=("$work/$source.o")
done
# The zlib, http_parser and cjs_lexer bindings' C (node_zlib, node_http_parser, node_cjs_lexer: Node's src/node_zlib.cc,
# src/node_http_parser.cc and src/node_cjs_lexer.cc below V8), over the headers of the zlib, brotli, zstd, llhttp and
# merve in libnode.so, with the
# defines zstd gives its dependents (zstd.gyp all_dependent_settings).
for source in node_zlib node_http_parser node_cjs_lexer; do
  "$cc" "${flags[@]}" -D_GNU_SOURCE "${zstddefines[@]}" -I"$uv/include" -I"$zlibsrc" -I"$brotlisrc/c/include" \
    -I"$zstdsrc/lib" -I"$llhttpsrc/include" -I"$mervesrc" -c "$repo/native/node/$source.c" -o "$work/$source.o" &
  pids+=($!)
  program+=("$work/$source.o")
done
finish
"$cc" -pthread -o "$out/node" "${program[@]}" "$cxxrt/lib/cpp-exception-tag.o" -L"$out" -lnode "${cxxlibs[@]}"
