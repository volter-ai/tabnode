[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / StdinRingWriter

# Class: StdinRingWriter

The producer's end of a ring: one writer, on a thread other than the run's.
Writes are taken in order; a write with no room waits for the reader with
`Atomics.waitAsync` (no timer), so it never blocks the producer's thread.

## Constructors

### Constructor

> **new StdinRingWriter**(`buffer`): `StdinRingWriter`

#### Parameters

##### buffer

`SharedArrayBuffer`

#### Returns

`StdinRingWriter`

## Methods

### close()

> **close**(): `void`

EOF: the reader takes what is left, then reads 0.

#### Returns

`void`

***

### write()

> **write**(`bytes`): `Promise`\<`void`\>

Bytes onto fd 0, after every earlier write; resolves when the ring holds all of them.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`Promise`\<`void`\>
