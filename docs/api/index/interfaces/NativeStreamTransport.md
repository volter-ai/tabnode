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
