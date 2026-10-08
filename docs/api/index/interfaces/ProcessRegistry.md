[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ProcessRegistry

# Interface: ProcessRegistry

Installed by the trusted embedding host before this realm starts runs.

## Extended by

- [`ProcessRegistryScope`](ProcessRegistryScope.md)

## Methods

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

### lookupGroup()?

> `optional` **lookupGroup**(`pgid`): `boolean`

A group may remain live after its leader exits.

#### Parameters

##### pgid

`number`

#### Returns

`boolean`

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
