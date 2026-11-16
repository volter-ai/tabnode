#!/bin/bash
# Builds the WALI program `node`, Node's native half as one program, as Node's own build links its executable
# (ADR-0019 §1, §2; ADR-0018 §3, items 7, 8 and 10): Node's C libraries, libuv, OpenSSL 3.5.8 and ncrypto, zlib,
# brotli 1.2.0, zstd 1.5.7, llhttp 9.4.3, merve, simdutf and simdjson; and Node's start and its standard streams' and
# signals' start and end, the loop's own handles, the engine's descriptor waits and the bindings' glue over them
# (native/node: one HandleWrap, the stream, TCP, pipe, TTY and UDP wraps, process_wrap, spawn_sync, signal_wrap,
# MessagePort, fs over uv_fs_*, and the crypto and tls_wrap bindings' OpenSSL half, as Node's src/*_wrap.cc,
# spawn_sync.cc, node_file.cc, node_dir.cc, fs_event_wrap.cc, node_constants.cc, node.cc's start, node_options.cc and
# src/crypto/*.cc). It needs `libc.so` and the SDK's C++ runtime alone. Every compile is browser-substrate's prepared
# native SDK with its Linux headers, whose compile wrapper adds WebAssembly exception handling and whose link wrapper
# makes a program PIE with the run path /opt/programs/lib, where the machine places `libc.so` and the C++ runtime.
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
# OpenSSL's configuration is native/openssl's generated set, made by Node's own procedure with Node's options and no-asm
# and kept as source (native/openssl/README.md). OpenSSL is compiled from that set as Node's deps/openssl/openssl.gyp
# compiles one of its own, with Node's defines (openssl.gyp, openssl_no_asm.gypi, openssl_common.gypi, and
# common.gypi's), its legacy provider built in as Node's libopenssl holds it. Each difference is named where it is
# made below (ADR-0016 §1).
#
# A change to Node's sources is a patch in native/patches, a recorded series applied in its order to the unpacked
# release tree before any of Node's sources is compiled.
#
# ncrypto, Node's crypto glue and every other C++ here use the SDK's C++ runtime, libc++ and libc++abi as shared
# libraries, as Linux's node links libstdc++.so.6 (browser-substrate ADR-0238 §4). The SDK's C++ driver compiles
# against its headers and adds libc++ and libc++abi to the link, and the SDK's link wrapper adds the one hidden
# unwinder a C++ link takes, so the script names no runtime library. The program's start file defines the process's
# exception tags, which every library imports (ADR-0238 §2).
#
# Usage: scripts/build-node.sh <native SDK> \
#   <libuv-a267f5688be25e8d4628e296245a041adc2ca072.tar.gz> <node-v24.21.0.tar.gz> <out directory>
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
sdk="$(cd "$1" && pwd)"
uv_archive="$2"
node_archive="$3"
out="$4"
echo "02d51895eb7a5fbeb283f3f2a237307987f4c114fb8ba947c7d80c9d5f8ca0af  $uv_archive" | shasum -a 256 -c - >/dev/null
echo "622424efb5dc0c26c93fbb619ff10737ee289c605b837c88778e186925d82777  $node_archive" | shasum -a 256 -c - >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jobs=$(getconf _NPROCESSORS_ONLN)
# Compiles run in parallel, at most one for each processor: `compile` starts one, first waiting for the oldest when
# that many run, and `finish` waits for the rest; each fails where a compile did.
pids=()
compile() {
  "$@" &
  pids+=($!)
  if (( ${#pids[@]} >= jobs )); then
    wait "${pids[0]}"
    pids=("${pids[@]:1}")
  fi
}
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
ncrypto="$work/$node/deps/ncrypto"
cc="$sdk/bin/cc"
cxx="$sdk/bin/cxx"
# Every compile, OpenSSL's and each dependency's included, is Node's Release build for Linux (common.gypi, for every
# target: -O3 and -fno-omit-frame-pointer in the Release configuration, _GLIBCXX_USE_CXX11_ABI=1, _FILE_OFFSET_BITS=64
# and __STDC_FORMAT_MACROS, and OPENSSL_NO_PINSHARED, OPENSSL_THREADS and OPENSSL_NO_ASM where Node's OpenSSL is its
# own, no-asm, in an executable (770-789); its warning flags aside). Node's -pthread, with atomics and bulk memory, is
# what every module of the machine is compiled with, which the SDK's compile driver gives (browser-substrate
# ADR-0240 §2).
# Linux's own headers (linux/errqueue.h and linux/if_packet.h, which libuv and OpenSSL include) are the target's and
# belong in the SDK's sysroot; the SDK lays them beside it, in linux-headers, read after musl's.
# The program's bytes name no directory of the build (ADR-0019 §1). Node's gyp build names a source relative to its
# tree (its make generator compiles $(srcdir)/deps/uv/src/unix/core.c, srcdir being the tree from out/); here each
# directory a compile reads is mapped out, so every name is relative to its root: the checkout's (native/node/fs.c,
# native/openssl/config/archs/linux-generic64/no-asm/crypto/params_idx.c),
# the scratch's (node-v24.21.0/deps/ncrypto/ncrypto.cc, libuv-a267f5688be25e8d4628e296245a041adc2ca072/src/unix/core.c,
# generated/node_options_header.inc) and the SDK's (its headers, by their path in the SDK).
flags=(-fPIC -O3 -fno-omit-frame-pointer -D_FILE_OFFSET_BITS=64 -D_GLIBCXX_USE_CXX11_ABI=1 -D__STDC_FORMAT_MACROS
  -DOPENSSL_NO_PINSHARED -DOPENSSL_THREADS -DOPENSSL_NO_ASM
  -idirafter "$sdk/linux-headers/usr/include"
  -ffile-prefix-map="$repo/"= -ffile-prefix-map="$work/"= -ffile-prefix-map="$sdk/"=)
# Node's C++ (common.gypi cflags_cc: -fno-rtti -fno-exceptions -fno-strict-aliasing -std=gnu++20), over the SDK's libc++
# headers.
cxxflags=(-fno-rtti -fno-exceptions -fno-strict-aliasing -std=gnu++20)

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
  compile "$cc" "${flags[@]}" "${defines[@]}" -I"$uv/include" -I"$uv/src" -c "$uv/src/$source.c" -o "$object"
  objects+=("$object")
done
finish

# zlib, brotli, zstd and llhttp's sources (item 10, below), unpacked first: OpenSSL depends on the first three.
tar xzf "$node_archive" -C "$work" "$node/deps/zlib" "$node/deps/brotli" "$node/deps/zstd" "$node/deps/llhttp" \
  "$node/deps/merve" "$node/deps/v8/third_party/simdutf" "$node/deps/simdjson" "$node/src/node_zlib.cc"
# Node's sources with native/patches' changes, in its series' order, once every source a patch names is unpacked.
while read -r patch; do
  "$sdk/bin/patch" -s -p1 -d "$work/$node" < "$repo/native/patches/$patch"
done < "$repo/native/patches/series"
zlibsrc="$work/$node/deps/zlib"
brotlisrc="$work/$node/deps/brotli"
zstdsrc="$work/$node/deps/zstd"
llhttpsrc="$work/$node/deps/llhttp"
mervesrc="$work/$node/deps/merve"
simdutfsrc="$work/$node/deps/v8/third_party/simdutf"
simdjsonsrc="$work/$node/deps/simdjson"
# What zstd.gyp gives every target that depends on it, OpenSSL among them (all_dependent_settings).
zstddefines=(-DXXH_NAMESPACE=ZSTD_ -DZSTD_MULTITHREAD -DZSTD_DISABLE_ASM)

# OpenSSL 3.5.8, compiled as Node's deps/openssl/openssl.gyp compiles its `openssl` target from one of its generated
# sets (ADR-0019 §1). The set is native/openssl/config/archs/linux-generic64/no-asm: OpenSSL's configuration with
# Node's options (deps/openssl/config/Makefile:33-36: no-tests no-shared no-afalgeng enable-ssl-trace enable-fips, and
# zlib, enable-brotli and enable-zstd over Node's deps/zlib, deps/brotli and deps/zstd for RFC 8879 certificate
# compression) and no-asm, made once by Node's own procedure (the Makefile's no-asm form and generate_gypi.pl) and kept
# as source, with its generated headers, crypto/buildinf.h among them (native/openssl/README.md). Nothing here
# configures OpenSSL: no OpenSSL Configure, Makefile or host compiler runs.
# The set's openssl.gypi is read as gyp reads it: its lists are the library's sources and defines, and a path in it is
# relative to Node's deps/openssl, where native/openssl stands for the set's own (./config/archs/...).
# Node's defines for the library besides the set's: openssl.gyp's OPENSSL_NO_HW, OPENSSL_API_COMPAT=0x10100001L,
# STATIC_LEGACY and MODULESDIR; openssl_no_asm.gypi's OPENSSL_NO_ASM and common.gypi's, which every compile has
# (above); openssl_common.gypi's for Linux, OPENSSLDIR "/etc/ssl", ENGINESDIR "/dev/null" and TERMIOS; and zstd.gyp's.
# Its include directories are the set's and openssl_common.gypi's, then zlib's, brotli's and zstd's, as each gyp file
# gives them to its dependents. The set's flags (openssl_cflags_linux-generic64: -Wall -O3 -pthread) are every
# compile's here: -O3 every target's, -pthread the SDK driver's, the warning flags aside.
# Differences from Node's, each named:
# - linux-generic64, where Node's sets are its hosts' targets: wasm32-linux-muslwali has a 64-bit `long` and 32-bit
#   pointers, OpenSSL's SIXTY_FOUR_BIT_LONG, the target browser-substrate's own OpenSSL recipe takes
#   (programs/native-providers/openssl).
# - MODULESDIR is /usr/lib/ossl-modules, the image's, where Node's names its own build tree (openssl.gyp's modules_dir).
# - The set's include directories come before OpenSSL's own, and Node's deps/openssl/config is not one of them. Node
#   reaches a set's generated headers through the headers it puts in their place in openssl/include, which choose
#   among its sets by the compiler's architecture macros (config/*_no-asm.h) and name no wasm32 target; with one set,
#   its own directories come first, so <openssl/opensslv.h> and every other generated header are the set's.
osslsrc="$work/$node/deps/openssl"
osslset="$repo/native/openssl/config/archs/linux-generic64/no-asm"
# gypi_list NAME prints the entries of the list NAME in the set's openssl.gypi, one to a line.
gypi_list() {
  awk -v open="'$1': [" -v q="'" '{ line = $0; gsub(/^ +| +$/, "", line) }
    on && line == "],"  { exit }
    on                  { gsub("^" q "|" q ",$", "", line); print line }
    line == open        { on = 1 }' "$osslset/openssl.gypi"
}
ossldefines=(-DOPENSSL_NO_HW -DOPENSSL_API_COMPAT=0x10100001L -DSTATIC_LEGACY -DMODULESDIR='"/usr/lib/ossl-modules"'
  -DOPENSSLDIR='"/etc/ssl"' -DENGINESDIR='"/dev/null"' -DTERMIOS "${zstddefines[@]}")
while read -r define; do ossldefines+=("-D$define"); done < <(gypi_list openssl_defines_linux-generic64)
osslincludes=(-I"$osslset" -I"$osslset/include" -I"$osslset/crypto" -I"$osslset/crypto/include/internal"
  -I"$osslset/providers/common/include" -I"$osslsrc/openssl" -I"$osslsrc/openssl/include" -I"$osslsrc/openssl/crypto"
  -I"$osslsrc/openssl/crypto/include" -I"$osslsrc/openssl/crypto/modes" -I"$osslsrc/openssl/crypto/ec/curve448"
  -I"$osslsrc/openssl/crypto/ec/curve448/arch_32" -I"$osslsrc/openssl/providers/common/include"
  -I"$osslsrc/openssl/providers/fips/include" -I"$osslsrc/openssl/providers/implementations/include"
  -I"$zlibsrc" -I"$brotlisrc/c/include" -I"$zstdsrc/lib")
# The library's sources are openssl_sources, libssl's, libcrypto's and the default, common and legacy providers', with
# the legacy provider's entry (providers/legacyprov.c, whose STATIC_LEGACY form is ossl_legacy_provider_init, the
# built-in provider crypto/provider_predefined.c names), and the set's generated sources; gyp compiles the C among
# them, not the set's linker scripts. The list names the three sources the default and legacy providers share twice
# (cipher_tdes_common.c, ripemd_prov.c, prov_running.c), and each is one object, as in Node's library.
osslobjects=()
while read -r source; do
  case $source in
    openssl/*.c) file="$osslsrc/$source" ;;
    ./config/*.c) file="$repo/native/openssl/${source#./}" ;;
    *) continue ;;
  esac
  object="$work/openssl-objects/${source#./}"
  object="${object%.c}.o"
  mkdir -p "${object%/*}"
  compile "$cc" "${flags[@]}" "${ossldefines[@]}" "${osslincludes[@]}" -c "$file" -o "$object"
  osslobjects+=("$object")
done < <({ gypi_list openssl_sources; gypi_list openssl_sources_linux-generic64; } | awk '!seen[$0]++')
finish
# What openssl.gyp gives a target that depends on it (direct_dependent_settings): OpenSSL's include and crypto/include
# directories and the set's, the set's first, as above, and the set's exported defines.
osslexport=(-I"$osslset/include" -I"$osslset" -I"$osslsrc/openssl/include" -I"$osslsrc/openssl/crypto/include")
while read -r define; do osslexport+=("-D$define"); done < <(gypi_list openssl_defines_exported_linux-generic64)

# ncrypto (deps/ncrypto/ncrypto.gyp): ncrypto.cc with its strict defines, and engine.cc as its ncrypto_engine target,
# each over OpenSSL as openssl.gyp gives it.
ncdefines=(-DNCRYPTO_BSSL_LIBDECREPIT_MISSING=1 -DOPENSSL_API_COMPAT=30000)
compile "$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_NO_DEPRECATED "${osslexport[@]}" \
  -I"$ncrypto" -c "$ncrypto/ncrypto.cc" -o "$work/ncrypto.o"
compile "$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_SUPPRESS_DEPRECATED \
  -DNCRYPTO_ENGINE_COMPAT=1 "${osslexport[@]}" -I"$ncrypto" -c "$ncrypto/engine.cc" -o "$work/ncrypto-engine.o"
finish

# zlib, brotli, zstd and llhttp (ADR-0018 item 10): Node v24.21.0's deps/zlib (Chromium's zlib, 1.3.2.1-motley, as Node
# ships it), deps/brotli (1.2.0), deps/zstd (1.5.7) and deps/llhttp (9.4.3), from the same release archive, each
# compiled with its gyp file's sources and defines and Node's Release flags for every target. Differences from Node's,
# each named:
# - zlib is zlib.gyp's target for an architecture with neither x86's nor NEON's optimizations, which wasm32 is:
#   BUILD.gn's "zlib" sources and inflate.c, CPU_NO_SIMD and HAVE_HIDDEN; none of its SIMD targets.
# - zstd's huf_decompress_amd64.S is not assembled, as Node's ZSTD_DISABLE_ASM leaves it.
# src/node_zlib.cc's DefineZlibConstants, its chunk and level bounds (74-88) and its mode enum (146-159) are extracted
# for node_constants.cc to compile, as Node's CreatePerContextProperties calls it (node_constants.cc:1357-1372).
deps=()
for source in adler32 compress cpu_features crc32 deflate gzclose gzlib gzread gzwrite infback inffast inftrees trees \
  uncompr zutil inflate; do
  compile "$cc" "${flags[@]}" -DCPU_NO_SIMD -DHAVE_HIDDEN -I"$zlibsrc" -c "$zlibsrc/$source.c" -o "$work/zlib-$source.o"
  deps+=("$work/zlib-$source.o")
done
for source in common/constants common/context common/dictionary common/platform common/shared_dictionary \
  common/transform dec/bit_reader dec/decode dec/huffman dec/prefix dec/state dec/static_init \
  enc/backward_references enc/backward_references_hq enc/bit_cost enc/block_splitter enc/brotli_bit_stream \
  enc/cluster enc/command enc/compound_dictionary enc/compress_fragment enc/compress_fragment_two_pass \
  enc/dictionary_hash enc/encode enc/encoder_dict enc/entropy_encode enc/fast_log enc/histogram enc/literal_cost \
  enc/memory enc/metablock enc/static_dict enc/static_dict_lut enc/static_init enc/utf8_util; do
  object="$work/brotli-${source//\//-}.o"
  compile "$cc" "${flags[@]}" -DOS_LINUX -I"$brotlisrc/c/include" -c "$brotlisrc/c/$source.c" -o "$object"
  deps+=("$object")
done
for source in common/debug common/entropy_common common/fse_decompress compress/fse_compress compress/huf_compress \
  decompress/huf_decompress common/pool common/threading common/xxhash common/zstd_common common/error_private \
  compress/hist compress/zstd_compress compress/zstd_compress_literals compress/zstd_compress_sequences \
  compress/zstd_compress_superblock compress/zstd_double_fast compress/zstd_fast compress/zstd_lazy compress/zstd_ldm \
  compress/zstd_opt compress/zstd_preSplit compress/zstdmt_compress decompress/zstd_ddict decompress/zstd_decompress \
  decompress/zstd_decompress_block; do
  object="$work/zstd-${source//\//-}.o"
  compile "$cc" "${flags[@]}" "${zstddefines[@]}" -I"$zstdsrc/lib" -c "$zstdsrc/lib/$source.c" -o "$object"
  deps+=("$object")
done
# llhttp is Node's for a Linux program, whose callbacks node_http_parser sets: api.c's JavaScript-host API is compiled
# off Linux alone, by native/patches' platform test (ADR-0019 §4).
for source in llhttp api http; do
  compile "$cc" "${flags[@]}" -I"$llhttpsrc" -I"$llhttpsrc/include" -c "$llhttpsrc/src/$source.c" -o "$work/llhttp-$source.o"
  deps+=("$work/llhttp-$source.o")
done
# merve (deps/merve/merve.gyp: merve.cpp, C++20, over V8's simdutf as include) and simdutf (tools/v8_gypfiles/v8.gyp's
# simdutf target: simdutf.cpp), the CommonJS export lexer internalBinding('cjs_lexer') is (ADR-0018 §7).
compile "$cxx" "${flags[@]}" "${cxxflags[@]}" -I"$simdutfsrc" -c "$simdutfsrc/simdutf.cpp" -o "$work/simdutf.o"
deps+=("$work/simdutf.o")
compile "$cxx" "${flags[@]}" "${cxxflags[@]}" -I"$mervesrc" -I"$simdutfsrc" -c "$mervesrc/merve.cpp" -o "$work/merve.o"
deps+=("$work/merve.o")
# simdjson (deps/simdjson/simdjson.gyp: simdjson.cpp), the JSON reader of Node's config file and `--run`
# (node_config_file.cc, node_task_runner.cc).
compile "$cxx" "${flags[@]}" "${cxxflags[@]}" -I"$simdjsonsrc" -c "$simdjsonsrc/simdjson.cpp" -o "$work/simdjson.o"
deps+=("$work/simdjson.o")
finish
mkdir -p "$work/generated"
{ sed -n '74,88p' "$work/$node/src/node_zlib.cc"; sed -n '146,159p' "$work/$node/src/node_zlib.cc"
  sed -n '1922,2106p' "$work/$node/src/node_zlib.cc"; } > "$work/generated/node_zlib_constants.inc"

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
  compile "$cc" "${flags[@]}" -D_GNU_SOURCE -I"$uv/include" -c "$repo/native/node/$source.c" -o "$work/$source.o"
  program+=("$work/$source.o")
done
for source in crypto_util crypto_context crypto_cipher crypto_tls crypto_x509 crypto_keys crypto_rsa crypto_dsa crypto_dh \
  crypto_ec crypto_pqc crypto_hash crypto_hmac crypto_random crypto_sig crypto_pbkdf2 crypto_scrypt crypto_hkdf \
  crypto_keygen crypto_aes crypto_chacha20_poly1305 crypto_kmac crypto_turboshake crypto_argon2 crypto_kem crypto_spkac \
  node_constants node_start; do
  compile "$cxx" "${flags[@]}" "${cxxflags[@]}" "${ncdefines[@]}" -DOPENSSL_NO_DEPRECATED -D_GNU_SOURCE -I"$uv/include" \
    "${osslexport[@]}" -I"$ncrypto" -I"$work/generated" -I"$work/$node/src" -I"$zlibsrc" -I"$brotlisrc/c/include" \
    -I"$zstdsrc/lib" -I"$simdjsonsrc" -c "$repo/native/node/$source.cc" -o "$work/$source.o"
  program+=("$work/$source.o")
done
# The zlib, http_parser and cjs_lexer bindings' C (node_zlib, node_http_parser, node_cjs_lexer: Node's src/node_zlib.cc,
# src/node_http_parser.cc and src/node_cjs_lexer.cc below V8), over the headers of the zlib, brotli, zstd, llhttp and
# merve the program links, with the defines zstd gives its dependents (zstd.gyp all_dependent_settings).
for source in node_zlib node_http_parser node_cjs_lexer; do
  compile "$cc" "${flags[@]}" -D_GNU_SOURCE "${zstddefines[@]}" -I"$uv/include" -I"$zlibsrc" -I"$brotlisrc/c/include" \
    -I"$zstdsrc/lib" -I"$llhttpsrc/include" -I"$mervesrc" -c "$repo/native/node/$source.c" -o "$work/$source.o"
  program+=("$work/$source.o")
done
finish

# The program, linked as Node's own build links its executable (ADR-0019 §1, §2). Every object is linked whole, as
# node.gyp links node_base (654-657) and node.gypi links libuv, zlib and OpenSSL's library, the legacy provider in it
# (168-170, 207-209, 416-418), into a node that is not shared, so an addon dlopen'd into the process finds all of each.
# It is linked with -rdynamic, as common.gypi links it (586), so the addon binds its imports to the program's
# definitions. The SDK's C++ driver links it, which adds the C++ runtime.
mkdir -p "$out"
"$cxx" -pthread -rdynamic -o "$out/node" "${program[@]}" "${objects[@]}" "$work/ncrypto.o" "$work/ncrypto-engine.o" \
  "${osslobjects[@]}" "${deps[@]}"
