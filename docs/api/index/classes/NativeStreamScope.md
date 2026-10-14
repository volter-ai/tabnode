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

### creditWrites()

> **creditWrites**(`id`, `word`): `object`

S2 T14: this handle's connection end's send credit (SendCredit). The first credited descriptor of an end gives its
`word`; a duplicate is answered with the end's word, which the realm then reserves from. Published now, after every
write made through any holder, and whenever the peer reads. A handle without a peer holds a word that publishes no
room and never reopens (it has no peer to read). Refused where the window and a chunk could pass 2^31.

#### Parameters

##### id

`number`

##### word

`Int32Array`

#### Returns

`object`

##### status

> **status**: `number`

##### word?

> `optional` **word?**: `Int32Array`\<`ArrayBufferLike`\>

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### finishTryWrite()

> **finishTryWrite**(`id`, `bytes`, `status`): `Promise`\<`number`\>

The caller's short wait ended after we claimed its attempt. Only the
native statuses that accepted NO bytes may enter the ordinary write queue.
Otherwise that same submission completes with its actual native status.

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

##### status

`number`

#### Returns

`Promise`\<`number`\>

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

### postWrite()

> **postWrite**(`id`, `bytes`): `number`

S2 T14: a write the realm accepted against this handle's credit, as native's write(2) into its send buffer: put in
the peer's queue now, in port order, never queued, never waited for capacity, so no close cancels it. Its status
is the realm's to report on the handle's next write (a failure); success has no answer.

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

#### Returns

`number`

***

### tryWrite()

> **tryWrite**(`id`, `bytes`): `number`

Node's DoTryWrite: never wait, queue, partially accept, or carry a handle.
The local binding copies bytes into the peer's native queue before returning
0, and schedules the reader separately. EAGAIN leaves that queue untouched.

#### Parameters

##### id

`number`

##### bytes

`Uint8Array`

#### Returns

`number`

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
