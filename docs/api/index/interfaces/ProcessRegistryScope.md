[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ProcessRegistryScope

# Interface: ProcessRegistryScope

The engine's own local registry (createProcessRegistryOwner's scope); a host's registry is a ProcessRegistry.

## Extends

- [`ProcessRegistry`](ProcessRegistry.md)

## Properties

### kernel?

> `readonly` `optional` **kernel?**: `boolean`

A registry over a kernel (browser-substrate ADR-0129): its `signal` is the kernel's kill(2), and the kernel
delivers it to whichever image runs the pid, an engine run of this realm or a program the host runs. Absent for
tabnode's own, whose `signal` reaches only this realm's runs.

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`kernel`](ProcessRegistry.md#kernel)

## Methods

### allocate()

> **allocate**(`parentPid?`, `newSession?`, `runAs?`): `number`

A new process's number. `parentPid` is the process that starts it, where the caller knows it, and `newSession`
says it leads a session of its own (a detached spawn): a registry over a kernel makes the process there and then,
as fork (and setsid) do (browser-substrate ADR-0129); tabnode's own ignores both.

#### Parameters

##### parentPid?

`number`

##### newSession?

`boolean`

##### runAs?

`Readonly`\<[`ProcessCredentials`](ProcessCredentials.md)\>

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

### disposition()?

> `optional` **disposition**(`pid`, `signal`, `handled`): `void`

`signal` of process `pid` is now handled (a listener for it) or not: a kernel's registry records it as the
process's disposition, from which the kernel protects a namespace's init (browser-substrate ADR-0129 4.4).

#### Parameters

##### pid

`number`

##### signal

`number`

##### handled

`boolean`

#### Returns

`void`

#### Inherited from

[`ProcessRegistry`](ProcessRegistry.md).[`disposition`](ProcessRegistry.md#disposition)

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

> **signal**(`pid`, `signal`, `callerPid?`): `boolean`

kill(2) in this registry's caller namespace. "0" checks existence without delivery, including a zombie until
reaped: its false means ESRCH only; other errno and transport failures throw. Signed targets keep kill's process
and group meanings. `callerPid` identifies the calling run for a standalone owner shared by several runs;
a kernel-bound registry already knows its caller from its channel.

#### Parameters

##### pid

`number`

##### signal

`string`

##### callerPid?

`number`

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
