[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ProcessRegistryScope

# Interface: ProcessRegistryScope

Installed by the trusted embedding host before this realm starts runs.

## Extends

- [`ProcessRegistry`](ProcessRegistry.md)

## Methods

### adoptRun()

> **adoptRun**(`source`, `sourceToken`, `token`, `parentPid?`): [`ProcessIdentity`](ProcessIdentity.md)

Trusted owner handoff before the destination worker starts; not a guest operation.

#### Parameters

##### source

`ProcessRegistryScope`

##### sourceToken

`string`

##### token

`string`

##### parentPid?

`number`

#### Returns

[`ProcessIdentity`](ProcessIdentity.md)

***

### allocate()

> **allocate**(): `number`

#### Returns

`number`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`allocate`](ProcessRegistry.md#allocate)

***

### dispose()

> **dispose**(): `void`

Ends this realm's registrations, including after abrupt worker death.

#### Returns

`void`

***

### forget()

> **forget**(`token`): `void`

#### Parameters

##### token

`string`

#### Returns

`void`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`forget`](ProcessRegistry.md#forget)

***

### lookup()

> **lookup**(`pid`): [`ProcessIdentity`](ProcessIdentity.md) \| `undefined`

#### Parameters

##### pid

`number`

#### Returns

[`ProcessIdentity`](ProcessIdentity.md) \| `undefined`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`lookup`](ProcessRegistry.md#lookup)

***

### publish()

> **publish**(`token`, `identity`): `void`

#### Parameters

##### token

`string`

##### identity

[`ProcessIdentity`](ProcessIdentity.md)

#### Returns

`void`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`publish`](ProcessRegistry.md#publish)

***

### receiveSignals()

> **receiveSignals**(`handler`): `void`

Trusted owner only: how this realm answers a signal sent to one of its processes.

#### Parameters

##### handler

(`pid`, `signal`) => `boolean`

#### Returns

`void`

***

### signal()

> **signal**(`pid`, `signal`): `boolean`

`kill(pid, signal)` for a live process of another realm in this container:
whether a process there took the signal. A machine lets a process signal
any process of its user, including one its parent left behind.

#### Parameters

##### pid

`number`

##### signal

`string`

#### Returns

`boolean`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`signal`](ProcessRegistry.md#signal)
