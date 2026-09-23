[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / LoopbackStreamFlow

# Interface: LoopbackStreamFlow

How a caller paces a streamed answer: `signal` ends the connection (the
reader went away), and `control` is handed the connection's pause and
resume, so a reader that holds no credit holds the server back instead of
a queue growing without bound.

## Properties

### signal?

> `optional` **signal?**: `AbortSignal`

## Methods

### control()?

> `optional` **control**(`pause`, `resume`): `void`

#### Parameters

##### pause

() => `void`

##### resume

() => `void`

#### Returns

`void`
