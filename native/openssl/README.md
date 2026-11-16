# OpenSSL's generated configuration

`config/archs/linux-generic64/no-asm/` is OpenSSL 3.5.8's configuration for the `node` program's target, generated
once by Node v24.21.0's own procedure and kept as source (ADR-0019 §1, ADR-0016 §1). `scripts/build-node.sh` compiles
OpenSSL from it as Node's `deps/openssl/openssl.gyp` compiles one of Node's sets: no OpenSSL `Configure`, Makefile or
host compiler runs at build time.

## What the set holds

It is laid out as Node's `deps/openssl/config/archs/<target>/no-asm/` is, and holds what `generate_gypi.pl` writes
for a target:

- the headers OpenSSL's build generates: `include/openssl/*.h`, `include/crypto/bn_conf.h` and `dso_conf.h`,
  `include/internal/param_names.h`, `include/progs.h` and `providers/common/include/prov/der_*.h`;
- `crypto/buildinf.h`, the platform, compiler line and date `OpenSSL_version` reports;
- the generated sources (`crypto/params_idx.c`, `providers/common/der/der_*_gen.c`, `apps/progs.c`) and linker
  scripts (`providers/legacy.ld`, `providers/fips.ld`);
- `configdata.pm`, the configuration `Configure` wrote;
- `openssl.gypi`, the library's source list, defines and flags, and `openssl-cl.gypi` and `openssl-fips.gypi`, the
  command line's and the FIPS module's.

A path in `openssl.gypi` is relative to Node's `deps/openssl`: `openssl/...` names a file of Node's tree, and
`./config/archs/...` a file of this set, `native/openssl` standing where `deps/openssl` stands.

## How it was generated

Node generates its sets on Linux (`deps/openssl/config/Makefile:4-7`), in the image its `deps/openssl/config/Dockerfile`
describes, by `make -C deps/openssl/config` in its tree (`make gen-openssl`). The Makefile names no `linux-generic64`;
its `$(NO_ASM_ARCHS)` rule (`:75-79`) is its no-asm form, `Configure` with Node's options (`:33-36`) and `no-asm`,
then `generate_gypi.pl no-asm`, and `NO_ASM_ARCHS=linux-generic64` on make's command line makes `linux-generic64` one
of its targets. The commands are Node's, unchanged.

- **Inputs.** Node's tree at its tag v24.21.0 (commit `955266bfdd854cd280dffd47548673914484e4c0`), from GitHub's
  archive of the tag, `https://github.com/nodejs/node/archive/refs/tags/v24.21.0.tar.gz`, SHA-256
  `a00e45375fe01977235ddb81ab6ac12f2f90161077cfbc2f77b8aaea4f75f8f9`: its `deps/openssl`, `deps/zlib`, `deps/brotli`
  and `deps/zstd`, as a git checkout at `/node`, as `make gen-openssl` gives the container Node's checkout. Its
  `deps/openssl` is the release archive's (`node-v24.21.0.tar.gz`, SHA-256
  `622424efb5dc0c26c93fbb619ff10737ee289c605b837c88778e186925d82777`, the one `scripts/build-node.sh` compiles) with
  OpenSSL's `doc/`, which `Configure` reads and Node's release archive rule removes (`Makefile:1227`).
- **Image.** Node's `deps/openssl/config/Dockerfile`: `ubuntu:22.04`
  (`sha256:9abcaffc92a5279fff3a6a41635c0800ea33e528425fb389658806476e7defde`) with binutils, build-essential, nasm, git
  and Perl's `Text::Template`, built for `linux/amd64`, the platform Node's own sets record (`configdata.pm`: Perl
  5.34.0 for `x86_64-linux-gnu-thread-multi`).
- **Date.** `SOURCE_DATE_EPOCH=1788826205`, the node recipe's (browser-substrate `programs/node/24.21.0`), which
  `util/mkbuildinf.pl` takes as the build date: `crypto/buildinf.h` says `built on: Tue Sep  8 00:10:05 2026 UTC`.
- **Command**, in a directory holding that tree as `node`:

  ```sh
  docker build --platform linux/amd64 -t node-openssl-builder node/deps/openssl/config/
  docker create --platform linux/amd64 --name node-openssl-gen -e SOURCE_DATE_EPOCH=1788826205 node-openssl-builder \
    make -C deps/openssl/config NO_ASM_ARCHS=linux-generic64 linux-generic64
  tar -C node -cf - . | docker cp - node-openssl-gen:/node
  docker start -a node-openssl-gen
  docker cp node-openssl-gen:/node/deps/openssl/config/archs/linux-generic64 - | tar -x -C native/openssl/config/archs
  ```

  The tree is copied into the container's `/node` where `make gen-openssl` mounts it. `generate_gypi.pl` writes the
  whole set and then cleans OpenSSL's tree, last with `git clean`, which git refuses in a checkout its user does not
  own; the set is complete before that step.

## How it differs from Node's `linux-x86_64/no-asm`

The file list is the same, and the source list (`openssl_sources`) and every generated header but one are equal. The
differences are `linux-generic64`'s own (OpenSSL's `Configurations/10-main.conf`): no `L_ENDIAN` among the defines,
`RC4_CHAR` among `bn_ops` (so `configuration.h`'s `RC4_INT` is `unsigned char`), no `-m64` among the flags and no
assembler architecture; and the target's name in `configdata.pm`, `buildinf.h`, the `.gypi` files and their paths.
