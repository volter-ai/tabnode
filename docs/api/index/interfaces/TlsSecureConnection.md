[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsSecureConnection

# Interface: TlsSecureConnection

The handshake's outcome, what Node's TLSSocket reports from `secureConnect` on.

## Properties

### alpnProtocol

> **alpnProtocol**: `string` \| `false`

The ALPN protocol the server chose, or false.

***

### authorizationError

> **authorizationError**: `Error` \| `undefined`

Why not, with Node's code (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, ...).

***

### authorized

> **authorized**: `boolean`

Whether the server's chain verified to a root and its certificate names the server.

***

### certificates

> **certificates**: readonly [`TlsPeerCertificate`](TlsPeerCertificate.md)[]

The server's certificates as it sent them, the leaf first.

***

### cipher

> **cipher**: `string`

The cipher suite, by its IANA name (`TLS_AES_128_GCM_SHA256`).

***

### version

> **version**: `string`

The protocol version, as Node names it (`TLSv1.3`).
