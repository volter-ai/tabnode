[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NativeStreamEvent

# Type Alias: NativeStreamEvent

> **NativeStreamEvent** = \{ `type`: `"closed"`; \} \| \{ `bytes?`: `Uint8Array`; `handle?`: [`NativeStreamDescriptor`](../interfaces/NativeStreamDescriptor.md); `id`: `number`; `status`: `number`; `type`: `"read"`; \} \| \{ `id`: `number`; `request`: `number`; `status`: `number`; `type`: `"shutdown"` \| `"close"`; \}
