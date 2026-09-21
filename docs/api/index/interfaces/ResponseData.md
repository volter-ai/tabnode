[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ResponseData

# Interface: ResponseData

What a page request answers with, the shape the bridge has always answered.

## Properties

### body?

> `optional` **body?**: `Uint8Array`\<`ArrayBufferLike`\>

Bytes, as a host's own server answers them; Node's Buffer is a Uint8Array. Absent where there is no body.

***

### headers

> **headers**: `Record`\<`string`, `string` \| `string`[]\>

A header's value is a string, or the strings of a header sent more than once, as Node's `res.getHeaders()` answers.

***

### statusCode

> **statusCode**: `number`

***

### statusMessage?

> `optional` **statusMessage?**: `string`

Absent where the server sent none, as Node's `res.statusMessage` may be.
