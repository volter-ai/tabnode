[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamOperation

# Type Alias: NativeStreamOperation

> **NativeStreamOperation** = \{ `kind`: `"pipe"`; `operation`: `"create"`; `type`: `number`; \} \| \{ `fd`: `number`; `operation`: `"fdType"`; \} \| \{ `id`: `number`; `operation`: `"pair"`; `peer`: `number`; \} \| \{ `id`: `number`; `operation`: `"duplicate"`; \} \| \{ `fd`: `number`; `id`: `number`; `operation`: `"open"`; \} \| \{ `id`: `number`; `operation`: `"readStart"` \| `"readStop"` \| `"ref"` \| `"unref"`; \} \| \{ `id`: `number`; `operation`: `"shutdown"` \| `"close"`; `request`: `number`; \}
