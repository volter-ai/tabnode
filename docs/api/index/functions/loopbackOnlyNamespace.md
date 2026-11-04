[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / loopbackOnlyNamespace

# Function: loopbackOnlyNamespace()

> **loopbackOnlyNamespace**(): [`NetworkNamespace`](../interfaces/NetworkNamespace.md)

A namespace with its loopback alone: a fresh one on Linux. It holds no address and answers no name; a port of its
loopback nothing listens on refuses, and every other address has no route.

## Returns

[`NetworkNamespace`](../interfaces/NetworkNamespace.md)
