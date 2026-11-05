[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / SocketMessage

# Interface: SocketMessage

A `struct msghdr` for a connected socket: its one buffer (`msg_iov`) and its ancillary data (`msg_control`), as
`struct cmsghdr` records laid out as on x86-64 Linux (a 16-byte header, `cmsg_len` eight bytes; records 8-byte
aligned). A receive sets `controlLength` (`msg_controllen`) and `flags` (`msg_flags`).

## Properties

### control?

> `readonly` `optional` **control?**: `Uint8Array`\<`ArrayBufferLike`\> \| `null`

The records a send carries, or the room a receive fills; none where null or absent.

***

### controlLength?

> `optional` **controlLength?**: `number`

***

### data

> `readonly` **data**: `Uint8Array`

The bytes a send takes, or the room a receive fills.

***

### flags?

> `optional` **flags?**: `number`
