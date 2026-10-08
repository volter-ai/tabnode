[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / preparedModuleKeyOf

# Function: preparedModuleKeyOf()

> **preparedModuleKeyOf**(`kind`, `contentSha256`): `string`

The name a prepared body goes under, from the plain SHA-256 of the file's bytes (64 lowercase hex): the format,
how the file is compiled, and that digest, as text. A tree that holds its files' digests names a body without
the file being read; where the image is built and in the tab it is this one function.

## Parameters

### kind

`"cjs"` \| `"js"`

### contentSha256

`string`

## Returns

`string`
