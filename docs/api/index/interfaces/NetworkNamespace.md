[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NetworkNamespace

# Interface: NetworkNamespace

What the host hands a realm: its network namespace.

## Properties

### id

> `readonly` **id**: `string`

The namespace's identity on its host. Realms given namespaces with one id share one loopback and one port space.

## Methods

### addresses()

> **addresses**(): readonly [`NamespaceAddress`](NamespaceAddress.md)[]

The addresses its interfaces hold besides loopback, in the order the interfaces were made (eth0 first).

#### Returns

readonly [`NamespaceAddress`](NamespaceAddress.md)[]

***

### connect()

> **connect**(`address`, `port`, `family`): [`NamespaceConnection`](../type-aliases/NamespaceConnection.md) \| `Promise`\<[`NamespaceConnection`](../type-aliases/NamespaceConnection.md)\>

Routes a connect to `address:port` that none of this namespace's listeners in this engine took.

#### Parameters

##### address

`string`

##### port

`number`

##### family

`4` \| `6`

#### Returns

[`NamespaceConnection`](../type-aliases/NamespaceConnection.md) \| `Promise`\<[`NamespaceConnection`](../type-aliases/NamespaceConnection.md)\>

***

### listen()

> **listen**(`listener`): `number` \| (() => `void`)

Told when a listener of this namespace starts listening: a nonzero libuv status refuses it (`UV_EADDRINUSE`, when
something the host holds has the port), else the function that is called when it stops.

#### Parameters

##### listener

[`NamespaceListener`](NamespaceListener.md)

#### Returns

`number` \| (() => `void`)

***

### resolve()

> **resolve**(`name`, `family`): [`ResolverAnswer`](../type-aliases/ResolverAnswer.md) \| `Promise`\<[`ResolverAnswer`](../type-aliases/ResolverAnswer.md)\>

The namespace's resolver (what its `/etc/resolv.conf` names): the addresses of `family` for `name`, `[]` when the
name exists with none of that family, `undefined` when it does not exist.

#### Parameters

##### name

`string`

##### family

`4` \| `6`

#### Returns

[`ResolverAnswer`](../type-aliases/ResolverAnswer.md) \| `Promise`\<[`ResolverAnswer`](../type-aliases/ResolverAnswer.md)\>
