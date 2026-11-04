[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / HttpClientTransportOptions

# Interface: HttpClientTransportOptions

## Properties

### hostService?

> `optional` **hostService?**: (`network`, `host`, `port`) => `boolean`

Whether `host`:`port`, as a process in `network` dials it, is a service its host serves itself rather than a
listener of any namespace (a service of the page's): HTTP to it goes through the host exchange. The host answers by
the namespace's routes, as its kernel would: the host's loopback is the host's namespace's alone, and a container
reaches the host at its gateway. Every other destination the namespace holds (its loopback, a name its resolver
answers, an address on one of its networks) is the namespace's own network; only what it does not hold leaves
through the exchange.

#### Parameters

##### network

[`NetworkNamespace`](NetworkNamespace.md)

##### host

`string`

##### port

`number`

#### Returns

`boolean`
