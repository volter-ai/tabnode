[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NamespaceConnection

# Type Alias: NamespaceConnection

> **NamespaceConnection** = `number` \| \{ `namespace`: `string`; `source`: `string`; \} \| \{ `source`: `string`; `accept`: `void`; \}

Where a connect the namespace's own listeners do not take goes, as the host answers it:
- a libuv status (`UV_ECONNREFUSED`, `UV_EHOSTUNREACH`, `UV_ENETUNREACH`, `UV_ETIMEDOUT`): failed, as the kernel
  fails it, and the socket's `connect` fails with that error. A host whose answer is dropped packets answers
  `UV_ETIMEDOUT` once Linux would have given up (`CONNECT_TIMEOUT_MS`), or leaves the promise pending: an answer
  that has not come by then is `ETIMEDOUT`, and one that fails or throws is `ECONNREFUSED`;
- `{ namespace, source }`: the address belongs to `namespace`, another namespace this engine serves listeners for;
  its listener on the port takes the connection, which leaves by `source` (the connector's address on the network
  the two share), and no listener there is `ECONNREFUSED`;
- `{ source, accept }`: a listener the host holds (a kernel program, a service of the host's own) takes it, leaving
  by `source`; `accept` is handed the connection's far end as a `net.Socket`, whose bytes are the connector's.
