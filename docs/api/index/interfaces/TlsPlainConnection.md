[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsPlainConnection

# Interface: TlsPlainConnection

The decrypted connection: what the server sends, and what the process writes to it.

## Methods

### close()

> **close**(): `void`

#### Returns

`void`

***

### end()

> **end**(): `void`

Sends close_notify, then ends the transport.

#### Returns

`void`

***

### onClose()

> **onClose**(`listener`): `void`

#### Parameters

##### listener

() => `void`

#### Returns

`void`

***

### onData()

> **onData**(`listener`): `void`

#### Parameters

##### listener

(`bytes`) => `void`

#### Returns

`void`

***

### onEnd()

> **onEnd**(`listener`): `void`

The server's close_notify, or the end of the connection after the handshake.

#### Parameters

##### listener

() => `void`

#### Returns

`void`

***

### onError()

> **onError**(`listener`): `void`

The failure that ended the connection, in Node's shape (`code`, and OpenSSL's `reason` where it has one).

#### Parameters

##### listener

(`error`) => `void`

#### Returns

`void`

***

### write()

> **write**(`bytes`): `void`

Bytes written before the handshake is done are sent once it is.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`
