[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / StdinReader

# Interface: StdinReader

What a run reads its fd 0 through: this module's ring, or a reader a host makes in the run's own realm over a pipe
of its kernel's, whatever that pipe's layout (browser-substrate ADR-0129 step 3.4: fd 0 is the kernel description it
is, read where the run is, with no thread copying it into a ring first). The four calls are the ring's own, with the
same answers: `take` never waits (a count, 0 at EOF, null when nothing is there yet), `takeBlocking` waits with
`Atomics.wait`, `takeAll` takes what is there, and `whenWritten` resolves, with no timer, once something has been
written or the last writer has gone.

## Methods

### take()

> **take**(`into`, `offset`, `length`): `number` \| `null`

#### Parameters

##### into

`Uint8Array`

##### offset

`number`

##### length

`number`

#### Returns

`number` \| `null`

***

### takeAll()

> **takeAll**(): `Uint8Array`\<`ArrayBufferLike`\> \| `null`

#### Returns

`Uint8Array`\<`ArrayBufferLike`\> \| `null`

***

### takeBlocking()

> **takeBlocking**(`into`, `offset`, `length`): `number`

#### Parameters

##### into

`Uint8Array`

##### offset

`number`

##### length

`number`

#### Returns

`number`

***

### whenWritten()

> **whenWritten**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>
