[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsServerOptions

# Interface: TlsServerOptions

## Properties

### cert

> **cert**: `Uint8Array`

Its certificate chain, PEM, the leaf first.

***

### key

> **key**: `Uint8Array`

The server's private key, PEM (PKCS #8, PKCS #1 or SEC 1; RSA, EC or Ed25519).

***

### protocols?

> `optional` **protocols?**: readonly `string`[]

ALPN protocols, in the server's preference; a client that offers only others is refused.
