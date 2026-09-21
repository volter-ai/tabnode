[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NodeResolverOptions

# Interface: NodeResolverOptions

## Properties

### conditionSets

> **conditionSets**: readonly readonly `string`[][]

Condition sets tried in order for a package `exports`/`imports` map; the first that names an existing file wins.

***

### conditionSetsFor?

> `optional` **conditionSetsFor?**: (`packageName`) => readonly readonly `string`[][] \| `undefined`

Condition sets for one package by name, where a package is resolved for a side its default sets do not name.

#### Parameters

##### packageName

`string`

#### Returns

readonly readonly `string`[][] \| `undefined`

***

### exports

> **exports**: [`ExportsResolver`](ExportsResolver.md)

***

### extensions

> **extensions**: readonly `string`[]

File extensions tried after the exact path, in order. Node's are `.js`, `.json`, `.node`.

***

### fs

> **fs**: [`ResolutionFs`](ResolutionFs.md)

***

### globalRoots?

> `optional` **globalRoots?**: readonly `string`[]

Directories searched after the walk-up, Node's global folders; the engine's `/node_modules`.

***

### mainFields

> **mainFields**: readonly `string`[]

Package fields naming the entry of a package without `exports`, in order. Node's is `main` alone.

***

### skipThrowingCjs?

> `optional` **skipThrowingCjs?**: `boolean`

A `.cjs` entry whose whole content is a `throw` is a stub for consumers that should import; skip it for the next condition set.

***

### sourceExtensions?

> `optional` **sourceExtensions?**: readonly `string`[]

Extensions a member's source may have, when the lane can run them.

***

### workspaceMembers?

> `optional` **workspaceMembers?**: () => `ReadonlySet`\<`string`\> \| `undefined`

Directories that are workspace members: an entry their build would write is answered by its source.

#### Returns

`ReadonlySet`\<`string`\> \| `undefined`
