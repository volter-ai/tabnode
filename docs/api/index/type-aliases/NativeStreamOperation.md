[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamOperation

# Type Alias: NativeStreamOperation

> **NativeStreamOperation** = \{ `kind`: `"tcp"` \| `"pipe"`; `operation`: `"create"`; `type`: `number`; \} \| \{ `fd`: `number`; `operation`: `"fdType"`; \} \| \{ `id`: `number`; `operation`: `"pair"`; `peer`: `number`; \} \| \{ `id`: `number`; `operation`: `"duplicate"`; \} \| \{ `address`: `string`; `flags?`: `number`; `id`: `number`; `ipv6?`: `boolean`; `operation`: `"bind"`; `port?`: `number`; \} \| \{ `backlog`: `number`; `id`: `number`; `operation`: `"listen"`; \} \| \{ `address`: `string`; `id`: `number`; `ipv6?`: `boolean`; `operation`: `"connect"`; `port?`: `number`; `request`: `number`; \} \| \{ `fd`: `number`; `id`: `number`; `operation`: `"open"`; \} \| \{ `id`: `number`; `operation`: `"readStart"` \| `"readStop"` \| `"ref"` \| `"unref"` \| `"getsockname"` \| `"getpeername"`; \} \| \{ `id`: `number`; `operation`: `"shutdown"` \| `"close"` \| `"reset"`; `request`: `number`; \}
