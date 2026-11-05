[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsClientOptions

# Interface: TlsClientOptions

## Properties

### ca

> **ca**: `Uint8Array`

The roots, a PEM bundle's bytes.

***

### protocols?

> `optional` **protocols?**: readonly `string`[]

ALPN protocols, in the client's preference.

***

### rejectUnauthorized

> **rejectUnauthorized**: `boolean`

As Node's: unless false, a chain or name that does not verify ends the handshake with that failure.

***

### servername

> **servername**: `string`

The server's name: what SNI carries (an IP address is not sent) and what its certificate must name.
