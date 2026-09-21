[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [esbuild](../README.md) / EsbuildHost

# Interface: EsbuildHost

An esbuild that runs elsewhere: a host a realm sends its builds to.

## Properties

### build

> **build**: (`options`) => `Promise`\<[`BuildResult`](BuildResult.md)\>

#### Parameters

##### options

[`BuildOptions`](BuildOptions.md)

#### Returns

`Promise`\<[`BuildResult`](BuildResult.md)\>

***

### neighbors?

> `optional` **neighbors?**: `boolean`

The host answers the `neighbors` option itself: a build carrying it
crosses with the option in place and no plugin, since a plugin is a
function in this realm and cannot cross. A host that does not say so is
given the shim's plugin, as esbuild itself would be.

***

### prebundle?

> `optional` **prebundle?**: (`options`) => `Promise`\<[`BuildResult`](BuildResult.md)\>

#### Parameters

##### options

[`BuildOptions`](BuildOptions.md)

#### Returns

`Promise`\<[`BuildResult`](BuildResult.md)\>

***

### transform

> **transform**: (`code`, `options?`) => `Promise`\<[`TransformResult`](TransformResult.md)\>

#### Parameters

##### code

`string`

##### options?

[`TransformOptions`](TransformOptions.md)

#### Returns

`Promise`\<[`TransformResult`](TransformResult.md)\>

***

### transformSync?

> `optional` **transformSync?**: (`code`, `options?`) => [`TransformResult`](TransformResult.md)

A host that can answer a transform before returning, native esbuild under a Node host, answers `transformSync`.

#### Parameters

##### code

`string`

##### options?

[`TransformOptions`](TransformOptions.md)

#### Returns

[`TransformResult`](TransformResult.md)
