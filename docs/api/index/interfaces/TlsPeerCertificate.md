[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TlsPeerCertificate

# Interface: TlsPeerCertificate

A certificate as Node's `getPeerCertificate()` describes it (OpenSSL's `X509ToObject`).

## Properties

### ca

> **ca**: `boolean`

***

### fingerprint

> **fingerprint**: `string`

SHA-1, SHA-256 and SHA-512 of the DER, colon-separated uppercase hex.

***

### fingerprint256

> **fingerprint256**: `string`

***

### fingerprint512

> **fingerprint512**: `string`

***

### issuer

> **issuer**: `Readonly`\<`Record`\<`string`, `string` \| readonly `string`[]\>\>

***

### raw

> **raw**: `Uint8Array`

The DER.

***

### serialNumber

> **serialNumber**: `string`

Uppercase hex.

***

### subject

> **subject**: `Readonly`\<`Record`\<`string`, `string` \| readonly `string`[]\>\>

Each attribute of the distinguished name by OpenSSL's short name (`CN`, `O`); a repeated one an array.

***

### subjectaltname?

> `optional` **subjectaltname?**: `string`

`DNS:a, IP Address:1.2.3.4`, where the certificate has a subjectAltName.

***

### valid\_from

> **valid\_from**: `string`

As OpenSSL prints a time: `Jan  5 01:02:03 2025 GMT`.

***

### valid\_to

> **valid\_to**: `string`
