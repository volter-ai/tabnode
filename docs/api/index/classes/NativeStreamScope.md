[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamScope

# Class: NativeStreamScope

One capability namespace per worker. Only the trusted host can inherit a
descriptor from another scope; wire operations can name this scope's IDs only.

## Constructors

### Constructor

> **new NativeStreamScope**(`limits`, `emit`, `ownerPid?`): `NativeStreamScope`

`ownerPid` names the process whose worker this scope serves: a listener
it opens is that process's socket, as the container's /proc shows it.

#### Parameters

##### limits

[`NativeStreamLimits`](../interfaces/NativeStreamLimits.md)

##### emit

(`event`) => `void`

##### ownerPid?

() => `number` \| `undefined`

#### Returns

`NativeStreamScope`

## Properties

### ownerPid?

> `readonly` `optional` **ownerPid?**: () => `number` \| `undefined`

#### Returns

`number` \| `undefined`

## Methods

### call()

> **call**(`operation`): [`NativeStreamReply`](../interfaces/NativeStreamReply.md)

Synchronous operations return libuv status; completions use the event door.

#### Parameters

##### operation

[`NativeStreamOperation`](../type-aliases/NativeStreamOperation.md)

#### Returns

[`NativeStreamReply`](../interfaces/NativeStreamReply.md)

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### handles()

> **handles**(): [`NativeStreamHandleView`](../interfaces/NativeStreamHandleView.md)[]

This scope's open handles, with the process it serves.

#### Returns

[`NativeStreamHandleView`](../interfaces/NativeStreamHandleView.md)[]

***

### inherit()

> **inherit**(`fd`, `source`, `id`): [`NativeStreamReply`](../interfaces/NativeStreamReply.md)

Trusted parent-to-child inheritance; this is deliberately absent from call().

#### Parameters

##### fd

`number`

##### source

`NativeStreamScope`

##### id

`number`

#### Returns

[`NativeStreamReply`](../interfaces/NativeStreamReply.md)

***

### write()

> **write**(`id`, `bytes`, `sentId?`): `Promise`\<`number`\>

Transport chunks are bounded and serialized per handle. Waiting for native
receive capacity retains at most one chunk per writer, within the scope's
explicit aggregate ceiling. No polling or copying a whole guest write.

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

##### sentId?

`number`

#### Returns

`Promise`\<`number`\>
