[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeNative

# Interface: TreeNative

The addon loads of one process.

## Methods

### load()

> **load**(`request`): [`NativeLoaded`](NativeLoaded.md) \| \{ `error`: `string`; \}

Loads one module into the process's user memory by the substrate's dynamic linker, running its relocations and
constructors, or answers the linker's own refusal (an ABI other than the process's, an import nothing answers).

#### Parameters

##### request

[`NativeLoadRequest`](NativeLoadRequest.md)

#### Returns

[`NativeLoaded`](NativeLoaded.md) \| \{ `error`: `string`; \}
