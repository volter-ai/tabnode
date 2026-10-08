[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamTransport

# Interface: NativeStreamTransport

## Properties

### limits

> `readonly` **limits**: `Readonly`\<[`NativeStreamLimits`](NativeStreamLimits.md)\>

## Methods

### call()

> **call**(`operation`): [`NativeStreamReply`](NativeStreamReply.md)

#### Parameters

##### operation

[`NativeStreamOperation`](../type-aliases/NativeStreamOperation.md)

#### Returns

[`NativeStreamReply`](NativeStreamReply.md)

***

### onEvent()

> **onEvent**(`listener`): () => `void`

#### Parameters

##### listener

(`event`) => `void`

#### Returns

() => `void`

***

### post()?

> `optional` **post**(`operation`): `void`

An operation whose answer nothing waits for, sent without waiting for
the owner: the owner takes it in order with every call after it, and one
it refuses completes with its status: a read grant as the handle's failed
read, a shutdown as its completion. Optional; without it each is a call.

#### Parameters

##### operation

\{ `id`: `number`; `operation`: `"readStart"`; \} \| \{ `id`: `number`; `operation`: `"shutdown"`; `request`: `number`; \}

#### Returns

`void`

***

### write()

> **write**(`id`, `bytes`, `handle?`): `Promise`\<`number`\>

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

##### handle?

`number`

#### Returns

`Promise`\<`number`\>
