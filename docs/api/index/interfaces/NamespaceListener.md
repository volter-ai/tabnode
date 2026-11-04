[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NamespaceListener

# Interface: NamespaceListener

A listener of the namespace, as the host is told of it.

## Properties

### address

> `readonly` **address**: `string`

The address it bound: a wildcard (`0.0.0.0`, `::`), a loopback address, or one of the namespace's own.

***

### family

> `readonly` **family**: `"IPv4"` \| `"IPv6"`

***

### port

> `readonly` **port**: `number`

## Methods

### open()

> **open**(`from`, `to`): `number` \| `Socket`

A connection to it from `from`, arriving at `to` (the address the connector dialled): the connector's end as a
`net.Socket`, or a libuv status when the listener takes no connection there (it closed, or it bound an address
that is not `to`: a server bound to 127.0.0.1 is not reached at the container's network address).

#### Parameters

##### from

###### address

`string`

###### port

`number`

##### to

`string`

#### Returns

`number` \| `Socket`
