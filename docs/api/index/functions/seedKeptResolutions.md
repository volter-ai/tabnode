[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / seedKeptResolutions

# Function: seedKeptResolutions()

> **seedKeptResolutions**(`entries`, `filesystem?`): `void`

Seeds the kept paths every table this realm makes from now on (ADR-0152): `(directory asked from + "\0" + name,
resolved path)` pairs, within the same bounds a process keeps. The host hands only a table made on the same files;
the engine cannot check that, and a table it was not given is never assumed. Call before the process's first require.

## Parameters

### entries

`Iterable`\<readonly \[`string`, `string`\]\>

### filesystem?

`object`

## Returns

`void`
