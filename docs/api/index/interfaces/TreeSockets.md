[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeSockets

# Interface: TreeSockets

The socket calls of one process, each Linux's of its name: a non-negative result or a negative errno.
Addresses the call fills are given 28 bytes, room for a `sockaddr_in6`.

## Methods

### accept4()

> **accept4**(`fd`, `flags`, `address`): `number`

accept4(2): answers the connection's descriptor and fills `address` with its peer, where given.

#### Parameters

##### fd

`number`

##### flags

`number`

##### address

`Uint8Array`\<`ArrayBufferLike`\> \| `null`

#### Returns

`number`

***

### bind()

> **bind**(`fd`, `address`): `number`

bind(2).

#### Parameters

##### fd

`number`

##### address

`Uint8Array`

#### Returns

`number`

***

### close()

> **close**(`fd`): `number`

close(2); a `wait` pending on the descriptor settles `POLLNVAL`.

#### Parameters

##### fd

`number`

#### Returns

`number`

***

### connect()

> **connect**(`fd`, `address`): `number`

connect(2): a non-blocking socket answers `-EINPROGRESS` and is writable once the connection is made or failed.

#### Parameters

##### fd

`number`

##### address

`Uint8Array`

#### Returns

`number`

***

### fcntl()

> **fcntl**(`fd`, `command`, `argument`): `number`

fcntl(2), for `F_GETFL`, `F_SETFL` and `F_DUPFD_CLOEXEC`.

#### Parameters

##### fd

`number`

##### command

`number`

##### argument

`number`

#### Returns

`number`

***

### getifaddrs()

> **getifaddrs**(): readonly [`InterfaceAddressEntry`](InterfaceAddressEntry.md)[]

getifaddrs(3): the addresses of the namespace's interfaces.

#### Returns

readonly [`InterfaceAddressEntry`](InterfaceAddressEntry.md)[]

***

### getpeername()

> **getpeername**(`fd`, `address`): `number`

getpeername(2).

#### Parameters

##### fd

`number`

##### address

`Uint8Array`

#### Returns

`number`

***

### getsockname()

> **getsockname**(`fd`, `address`): `number`

getsockname(2).

#### Parameters

##### fd

`number`

##### address

`Uint8Array`

#### Returns

`number`

***

### getsockopt()

> **getsockopt**(`fd`, `level`, `name`, `value`): `number`

getsockopt(2): fills `value`, answers the option's length.

#### Parameters

##### fd

`number`

##### level

`number`

##### name

`number`

##### value

`Uint8Array`

#### Returns

`number`

***

### listen()

> **listen**(`fd`, `backlog`): `number`

listen(2).

#### Parameters

##### fd

`number`

##### backlog

`number`

#### Returns

`number`

***

### recvfrom()

> **recvfrom**(`fd`, `buffer`, `flags`, `address`): `number`

recvfrom(2): answers the bytes read (0 at a stream's end) and fills `address` with the source, where given.

#### Parameters

##### fd

`number`

##### buffer

`Uint8Array`

##### flags

`number`

##### address

`Uint8Array`\<`ArrayBufferLike`\> \| `null`

#### Returns

`number`

***

### recvmsg()

> **recvmsg**(`fd`, `message`, `flags`): `number`

recvmsg(2): answers the bytes read (0 at a stream's end) into `message.data`, fills `message.control` with the
records that came with them (descriptors an `SCM_RIGHTS` record carries installed in this process's table), and
sets `message.controlLength` and `message.flags`.

#### Parameters

##### fd

`number`

##### message

[`SocketMessage`](SocketMessage.md)

##### flags

`number`

#### Returns

`number`

***

### sendmsg()

> **sendmsg**(`fd`, `message`, `flags`): `number`

sendmsg(2) on a connected socket: answers the bytes taken; an `SCM_RIGHTS` record's descriptors go with them.

#### Parameters

##### fd

`number`

##### message

[`SocketMessage`](SocketMessage.md)

##### flags

`number`

#### Returns

`number`

***

### sendto()

> **sendto**(`fd`, `data`, `flags`, `address`): `number`

sendto(2): `address` null for a connected socket; answers the bytes taken.

#### Parameters

##### fd

`number`

##### data

`Uint8Array`

##### flags

`number`

##### address

`Uint8Array`\<`ArrayBufferLike`\> \| `null`

#### Returns

`number`

***

### setsockopt()

> **setsockopt**(`fd`, `level`, `name`, `value`): `number`

setsockopt(2).

#### Parameters

##### fd

`number`

##### level

`number`

##### name

`number`

##### value

`Uint8Array`

#### Returns

`number`

***

### shutdown()

> **shutdown**(`fd`, `how`): `number`

shutdown(2).

#### Parameters

##### fd

`number`

##### how

`number`

#### Returns

`number`

***

### socket()

> **socket**(`domain`, `type`, `protocol`): `number`

socket(2): `type` may carry `SOCK_NONBLOCK` and `SOCK_CLOEXEC`; answers the descriptor.

#### Parameters

##### domain

`number`

##### type

`number`

##### protocol

`number`

#### Returns

`number`

***

### socketpair()

> **socketpair**(`domain`, `type`, `protocol`, `pair`): `number`

socketpair(2): fills `pair` with the two connected descriptors; `type` as socket's.

#### Parameters

##### domain

`number`

##### type

`number`

##### protocol

`number`

##### pair

`Int32Array`

#### Returns

`number`

***

### wait()

> **wait**(`fd`, `events`): `Promise`\<`number`\>

The descriptor's readiness, as poll(2) reports it: settles with its `revents` once any of `events`, or
`POLLERR`, `POLLHUP` or `POLLNVAL`, holds (at once if one does). Never rejects.

#### Parameters

##### fd

`number`

##### events

`number`

#### Returns

`Promise`\<`number`\>
