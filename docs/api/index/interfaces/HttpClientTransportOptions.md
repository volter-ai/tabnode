[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / HttpClientTransportOptions

# Interface: HttpClientTransportOptions

## Properties

### hostPorts?

> `optional` **hostPorts?**: () => `ReadonlySet`\<`number`\>

Loopback ports the host itself serves (a service of the page, not a
guest's listener). Plain HTTP to one of them goes through the host
exchange; every other loopback port stays the engine's own network.

#### Returns

`ReadonlySet`\<`number`\>
