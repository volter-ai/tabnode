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

> **allocate**(`parentPid?`, `newSession?`): `number`

A new process's number. `parentPid` is the process that starts it, where the caller knows it, and `newSession`
says it leads a session of its own (a detached spawn): a registry over a kernel makes the process there and then,
as fork (and setsid) do (browser-substrate ADR-0129); tabnode's own ignores both.

#### Parameters

##### parentPid?

`number`

##### newSession?

`boolean`

#### Returns

`number`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`allocate`](ProcessRegistry.md#allocate)

***

### claim()

> **claim**(`pid`): `void`

Trusted owner only: a run the embedder already numbered, as a kernel
numbers a `node` its shell exec'd. Its parent is the embedder's process,
which this registry need not hold.

#### Parameters

##### pid

`number`

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Ends this realm's registrations, including after abrupt worker death.

#### Returns

`void`

***

### exec()

> **exec**(`token`, `identity`): `void`

execve(2) into a process forked elsewhere: an image starts in this realm in a process whose fork already made it
(a kernel shell's child exec'ing `node`), keeping its pid and parent. No process is made here; a pid the registry
does not hold answers loudly. Every other pid this realm publishes is one its `allocate` made.

#### Parameters

##### token

`string`

##### identity

[`ProcessIdentity`](ProcessIdentity.md)

#### Returns

`void`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`exec`](ProcessRegistry.md#exec)

***

### exit()

> **exit**(`pid`, `parentPid`, `code`, `signal`): `void`

exit_group for `pid`, a child forked under `parentPid` whose image this realm ran itself (an engine run): ended
with `code`, or by `signal`. A child another realm or the host runs reports its own exit.

#### Parameters

##### pid

`number`

##### parentPid

`number`

##### code

`number`

##### signal

`string` \| `null`

#### Returns

`void`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`exit`](ProcessRegistry.md#exit)

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

### lookupGroup()?

> `optional` **lookupGroup**(`pgid`): `boolean`

A group may remain live after its leader exits.

#### Parameters

##### pgid

`number`

#### Returns

`boolean`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`lookupGroup`](ProcessRegistry.md#lookupgroup)

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

### reap()

> **reap**(`pid`, `parentPid`, `code`, `signal`): `object`

wait4 for `pid`, a child forked under `parentPid`, once its run has ended: the end its parent reports (Node's
'exit' code and signal). A registry over a kernel answers with the zombie's status and reaps it; tabnode's own,
which is its own kernel, answers with the end its run gave.

#### Parameters

##### pid

`number`

##### parentPid

`number`

##### code

`number`

##### signal

`string` \| `null`

#### Returns

`object`

##### code

> **code**: `number`

##### signal

> **signal**: `string` \| `null`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`reap`](ProcessRegistry.md#reap)

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

***

### signalGroup()?

> `optional` **signalGroup**(`pgid`, `signal`): `boolean`

Deliver to every live group member; true when any member took it.

#### Parameters

##### pgid

`number`

##### signal

`string`

#### Returns

`boolean`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`signalGroup`](ProcessRegistry.md#signalgroup)
