[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NamespaceAddress

# Interface: NamespaceAddress

One address an interface of the namespace holds (a container's address on one network it joined).

## Properties

### address

> **address**: `string`

***

### interface?

> `optional` **interface?**: `string`

The interface that holds it (`eth0`): a network's IPv4 and IPv6 addresses are one interface's. An address that
names none is an interface of its own, in order.

***

### mac?

> `optional` **mac?**: `string`

The interface's hardware address, when the host gives one (Docker's is 02:42 and the IPv4 address).

***

### prefixLength

> **prefixLength**: `number`

The network's prefix length: 16 for a /16.
