[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeTls

# Interface: TreeTls

The TLS a host offers its processes.

## Methods

### connect()

> **connect**(`transport`, `options`): [`TlsClientSession`](TlsClientSession.md)

Starts a client handshake over `transport`.

#### Parameters

##### transport

[`TlsTransport`](TlsTransport.md)

##### options

[`TlsClientOptions`](TlsClientOptions.md)

#### Returns

[`TlsClientSession`](TlsClientSession.md)

***

### serve()

> **serve**(`transport`, `options`): [`TlsServerSession`](TlsServerSession.md)

Answers a client's handshake over `transport`, with the program's own key and chain.

#### Parameters

##### transport

[`TlsTransport`](TlsTransport.md)

##### options

[`TlsServerOptions`](TlsServerOptions.md)

#### Returns

[`TlsServerSession`](TlsServerSession.md)
