[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ModuleEvaluationObserver

# Interface: ModuleEvaluationObserver

Host-only execution evidence. No observer function is installed in Node globals or Module exports.

## Methods

### observes()

> **observes**(`filename`): `boolean`

#### Parameters

##### filename

`string`

#### Returns

`boolean`

***

### observesSource()?

> `optional` **observesSource**(`filename`): `boolean`

Request original-source evidence only for these exact filenames.

#### Parameters

##### filename

`string`

#### Returns

`boolean`

***

### onEvaluated()

> **onEvaluated**(`filename`, `exports`, `evidence?`): `void`

#### Parameters

##### filename

`string`

##### exports

`unknown`

##### evidence?

[`ModuleEvaluationEvidence`](ModuleEvaluationEvidence.md)

#### Returns

`void`
