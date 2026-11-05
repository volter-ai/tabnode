[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsClientSession

# Interface: TlsClientSession

## Properties

### plain

> **plain**: [`TlsPlainConnection`](TlsPlainConnection.md)

***

### secure

> **secure**: `Promise`\<[`TlsSecureConnection`](TlsSecureConnection.md)\>

Settles once: when the handshake is done, or with the failure that ended it (also given to `plain.onError`).

## Methods

### receive()

> **receive**(`bytes`): `void`

Where the server's bytes go: its records, its FIN, the connection's close.

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
