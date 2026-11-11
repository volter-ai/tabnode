[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeLoadRequest

# Interface: NativeLoadRequest

One addon load.

## Properties

### bytes

> `readonly` **bytes**: `Uint8Array`

The file's bytes: a WebAssembly side module with a `dylink.0` section.

***

### imports

> `readonly` **imports**: `WebAssembly.Imports`

The engine's imports, beside the process's `wali` imports and the linker's own: `env`, `napi`, `emnapi`.

***

### path

> `readonly` **path**: `string`

The file's path, as `dlopen` names it in its errors.

***

### thread

> `readonly` **thread**: `object`

A thread's side of `imports`: each thread worker the process starts for this module imports `module` and calls its
`threadImports(queue)` for the imports it instantiates the module with.

#### module

> `readonly` **module**: `string`

#### queue

> `readonly` **queue**: `SharedArrayBuffer`
