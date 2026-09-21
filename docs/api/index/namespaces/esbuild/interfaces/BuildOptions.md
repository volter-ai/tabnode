[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [esbuild](../README.md) / BuildOptions

# Interface: BuildOptions

## Properties

### absWorkingDir?

> `optional` **absWorkingDir?**: `string`

***

### bundle?

> `optional` **bundle?**: `boolean`

***

### entryPoints?

> `optional` **entryPoints?**: `string`[] \| `Record`\<`string`, `string`\>

esbuild's two entry forms: a list of files, and the named form
`{ out: "in.ts" }` that gives each output its own name. Only the list is
made absolute against the working directory; the named form is passed on
as it was written.

***

### external?

> `optional` **external?**: `string`[]

***

### format?

> `optional` **format?**: `"cjs"` \| `"iife"` \| `"esm"`

***

### minify?

> `optional` **minify?**: `boolean`

***

### neighbors?

> `optional` **neighbors?**: `object`

The packages this build is not of: an import of one is left to whoever
builds it, external under the specifier it was written with, rather than
bundled in. `self` are the specifiers this build IS of, which stay inside
it however they are imported. The ones an import actually reached come
back as `neighbors` on the result.

#### names

> **names**: `string`[]

#### self?

> `optional` **self?**: `string`[]

***

### outdir?

> `optional` **outdir?**: `string`

***

### outfile?

> `optional` **outfile?**: `string`

***

### platform?

> `optional` **platform?**: `"node"` \| `"browser"` \| `"neutral"`

***

### plugins?

> `optional` **plugins?**: `unknown`[]

***

### sourcemap?

> `optional` **sourcemap?**: `boolean` \| `"external"` \| `"inline"`

***

### stdin?

> `optional` **stdin?**: `object`

#### contents

> **contents**: `string`

#### loader?

> `optional` **loader?**: `"json"` \| `"js"` \| `"jsx"` \| `"ts"` \| `"tsx"` \| `"css"`

#### resolveDir?

> `optional` **resolveDir?**: `string`

***

### target?

> `optional` **target?**: `string` \| `string`[]

***

### tsconfig?

> `optional` **tsconfig?**: `string`

Path of a tsconfig, read from the engine's filesystem and handed to esbuild as `tsconfigRaw`.

***

### tsconfigRaw?

> `optional` **tsconfigRaw?**: `string` \| `TsconfigJson`

***

### workspacePaths?

> `optional` **workspacePaths?**: `Record`\<`string`, `string`[]\>

Where a workspace member's sources are, as tsconfig paths with absolute targets.

***

### write?

> `optional` **write?**: `boolean`
