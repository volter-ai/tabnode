[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / InterfaceAddressEntry

# Interface: InterfaceAddressEntry

One address of an interface, as `getifaddrs(3)` lists it (`struct ifaddrs`).

## Properties

### address

> `readonly` **address**: `Uint8Array`

`ifa_addr`: a `sockaddr_in` or `sockaddr_in6`.

***

### flags

> `readonly` **flags**: `number`

`ifa_flags`: `IFF_UP`, `IFF_RUNNING`, `IFF_LOOPBACK` and the rest.

***

### hardware?

> `readonly` `optional` **hardware?**: `Uint8Array`\<`ArrayBufferLike`\>

The interface's hardware address (its `AF_PACKET` entry's `sll_addr`), six bytes; none for the loopback.

***

### name

> `readonly` **name**: `string`

`ifa_name`: `lo`, `eth0`.

***

### netmask

> `readonly` **netmask**: `Uint8Array`

`ifa_netmask`: a sockaddr of the same family.
