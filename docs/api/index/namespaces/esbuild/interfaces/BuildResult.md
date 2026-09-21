[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [esbuild](../README.md) / BuildResult

# Interface: BuildResult

## Properties

### errors

> **errors**: `unknown`[]

***

### metafile?

> `optional` **metafile?**: `object`

#### inputs?

> `optional` **inputs?**: `Record`\<`string`, `unknown`\>

#### outputs?

> `optional` **outputs?**: `Record`\<`string`, `unknown`\>

***

### neighbors?

> `optional` **neighbors?**: `string`[]

The specifiers `neighbors` left external, sorted; absent when a build named none.

***

### outputFiles?

> `optional` **outputFiles?**: `object`[]

#### contents

> **contents**: `Uint8Array`

#### path

> **path**: `string`

#### text

> **text**: `string`

***

### warnings

> **warnings**: `unknown`[]
