[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsServerSession

# Interface: TlsServerSession

## Properties

### plain

> **plain**: [`TlsPlainConnection`](TlsPlainConnection.md)

***

### secure

> **secure**: `Promise`\<[`TlsServerSecureConnection`](TlsServerSecureConnection.md)\>

Settles once: when the client's Finished verifies, or with the failure that ended the handshake.

## Methods

### receive()

> **receive**(`bytes`): `void`

Where the client's bytes go: its records, its FIN, the connection's close.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`

***

### receiveClose()

> **receiveClose**(): `void`

#### Returns

`void`

***

### receiveEnd()

> **receiveEnd**(): `void`

#### Returns

`void`
