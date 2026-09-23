[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ProcessRegistry

# Interface: ProcessRegistry

Installed by the trusted embedding host before this realm starts runs.

## Extended by

- [`ProcessRegistryScope`](ProcessRegistryScope.md)

## Methods

### allocate()

> **allocate**(): `number`

#### Returns

`number`

***

### forget()

> **forget**(`token`): `void`

#### Parameters

##### token

`string`

#### Returns

`void`

***

### lookup()

> **lookup**(`pid`): [`ProcessIdentity`](ProcessIdentity.md) \| `undefined`

#### Parameters

##### pid

`number`

#### Returns

[`ProcessIdentity`](ProcessIdentity.md) \| `undefined`

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
