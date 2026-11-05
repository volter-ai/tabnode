[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsTransport

# Interface: TlsTransport

The connection the client writes its records to: the engine's side of the process's TCP socket.

## Methods

### close()

> **close**(): `void`

The client is done with the connection.

#### Returns

`void`

***

### end()

> **end**(): `void`

The client will write no more (after its close_notify): the socket's write side shuts down.

#### Returns

`void`

***

### write()

> **write**(`bytes`): `void`

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`
