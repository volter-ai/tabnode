[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamTransport

# Interface: NativeStreamTransport

## Properties

### limits

> `readonly` **limits**: `Readonly`\<[`NativeStreamLimits`](NativeStreamLimits.md)\>

***

### postsRefs?

> `readonly` `optional` **postsRefs?**: `boolean`

Whether `post` takes `ref` and `unref` too (S2 R73): a transport that does not say so is posted neither, and they
stay calls. A handle's ref only keeps the owner's loop alive for it; nothing waits for its answer.

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

\{ `id`: `number`; `operation`: `"readStart"`; \} \| \{ `id`: `number`; `operation`: `"shutdown"`; `request`: `number`; \} \| \{ `id`: `number`; `operation`: `"ref"` \| `"unref"`; \}

#### Returns

`void`

***

### tryWriteWithinBudget()?

> `optional` **tryWriteWithinBudget**(`id`, `bytes`, `trace?`): `number` \| `Promise`\<`number`\> \| `undefined`

Whole bounded write, without a descriptor: 0 means all bytes accepted.
EAGAIN (or undefined when local credit prevents an attempt) accepts none.
The host bounds the synchronous wait. A Promise owns the ALREADY submitted
write's async completion: do not submit its bytes again. Older holders omit
this bounded method and their ordered writes stay async.

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

##### trace?

[`NativeStreamWriteTrace`](NativeStreamWriteTrace.md)

#### Returns

`number` \| `Promise`\<`number`\> \| `undefined`

***

### write()

> **write**(`id`, `bytes`, `handle?`, `trace?`): `Promise`\<`number`\>

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

##### handle?

`number`

##### trace?

[`NativeStreamWriteTrace`](NativeStreamWriteTrace.md)

#### Returns

`Promise`\<`number`\>
