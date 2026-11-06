#!/bin/bash
# Builds src/node-lib/binding/ada-idna-wasm.ts: Ada's own `ada::idna::to_ascii`, from Node v24.21.0's deps/ada
# (Ada 4.0.0), compiled to a plain WebAssembly module by wasi-sdk 34.0 (ADR-0009 §3). Every input is pinned by digest.
# Ada's notice (its release LICENSE-MIT) and its linked runtime's (wasi-libc, libc++, libc++abi, compiler-rt builtins)
# are carried in THIRD-PARTY-NOTICES.md, "Ada notice" and "Ada module runtime notices".
# Usage: scripts/build-ada-idna-wasm.sh
# The script owns its scratch: a directory of its own from mktemp -d, removed by its EXIT trap however it ends.
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/src/node-lib/binding/ada-idna-wasm.ts"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
fetch() { curl -sfL -o "$2" "$1"; echo "$3  $2" | shasum -a 256 -c - >/dev/null; }
node=https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/ada
fetch "$node/ada.cpp" ada.cpp 1c722f8f5355d6bf2bf3601870684edc875aa8f56b4d4735440d96263dd0207c
fetch "$node/ada.h" ada.h 0010b17b3ff489e13998e86d921b16e1643e370ee3276c584f1b0c4b72bdf628
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) sdk=wasi-sdk-34.0-arm64-macos; digest=9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9 ;;
  *) echo "this build pins wasi-sdk 34.0 for Darwin arm64 only; add this host's release digest" >&2; exit 1 ;;
esac
fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$sdk.tar.gz" sdk.tar.gz "$digest"
tar xzf sdk.tar.gz && rm sdk.tar.gz
# The ada::idna sections of the amalgamation: its header (ada.h 32-240) and its body (ada.cpp 140-6720).
sed -n '32,240p' ada.h > ada_idna.h
sed -n '140,6720p' ada.cpp > ada_idna_body.inc
cat > idna_wasm.cpp <<'CPP'
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include "ada_idna.h"
#include "ada_idna_body.inc"
static std::vector<char> input;
static std::string output;
extern "C" {
__attribute__((export_name("tabnode_idna_input"))) char* tabnode_idna_input(uint32_t length) {
  input.resize(length ? length : 1);
  return input.data();
}
__attribute__((export_name("tabnode_idna_to_ascii"))) uint32_t tabnode_idna_to_ascii(uint32_t length) {
  output = ada::idna::to_ascii(std::string_view(input.data(), length));
  return static_cast<uint32_t>(output.size());
}
__attribute__((export_name("tabnode_idna_result"))) const char* tabnode_idna_result() { return output.data(); }
}
CPP
"$sdk/bin/clang++" --target=wasm32-wasip1 --sysroot="$sdk/share/wasi-sysroot" -std=c++20 -O2 -fno-exceptions \
  -mexec-model=reactor -Wl,--strip-all -o idna.wasm idna_wasm.cpp
bytes=$(wc -c < idna.wasm | tr -d ' ')
sum=$(shasum -a 256 idna.wasm | cut -d' ' -f1)
{
  echo "/**"
  echo " * Ada's own \`ada::idna::to_ascii\`, compiled to WebAssembly (ADR-0009 §3). Built by"
  echo " * \`scripts/build-ada-idna-wasm.sh\` from Node v24.21.0's \`deps/ada\` (Ada 4.0.0; ada.h 32-240, ada.cpp"
  echo " * 140-6720) with wasi-sdk 34.0, without \`ADA_USE_SIMDUTF\`. Regenerate it with that script; do not edit it."
  echo " *"
  echo " *   bytes:   $bytes"
  echo " *   sha256:  $sum"
  echo " *   license: MIT, Copyright 2023 Yagiz Nizipli and Daniel Lemire; notice in THIRD-PARTY-NOTICES.md (\"Ada notice\")"
  echo " *   runtime: wasi-libc, libc++, libc++abi, compiler-rt builtins; THIRD-PARTY-NOTICES.md (\"Ada module runtime notices\")"
  echo " */"
  echo "export const ADA_IDNA_WASM_BASE64 ="
  base64 -i idna.wasm | tr -d '\n' | fold -w 100 | sed "s/.*/  '&' +/;\$ s/ +\$/;/"
} > "$out"
echo "$out: $bytes bytes, sha256 $sum"
