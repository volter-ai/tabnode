[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeSystem

# Interface: TreeSystem

A process's system calls, as a kernel's tree offers them. Each is the Linux call of its name, made by the calling
process; a failure throws an error carrying the call's `code`.

## Properties

### trace

> `readonly` **trace**: ((`line`) => `void`) \| `null`

The process's trace, a line at a time; null where none is selected.

## Methods

### affinity()

> **affinity**(): `number`

sched_getaffinity(2) of the process: how many CPUs it may run on.

#### Returns

`number`

***

### clock()

> **clock**(`id`): `bigint`

clock_gettime(2) of CLOCK_REALTIME (0) or CLOCK_MONOTONIC (1), in nanoseconds.

#### Parameters

##### id

`0` \| `1`

#### Returns

`bigint`

***

### file()

> **file**(`path`): `string` \| `undefined`

A file of the kernel's (`/proc/...`), read whole; undefined where it cannot be read.

#### Parameters

##### path

`string`

#### Returns

`string` \| `undefined`

***

### random()

> **random**(`into`): `void`

getrandom(2): `into` filled whole from the kernel's random pool.

#### Parameters

##### into

`Uint8Array`

#### Returns

`void`

***

### sysinfo()

> **sysinfo**(): [`SystemInfo`](SystemInfo.md)

#### Returns

[`SystemInfo`](SystemInfo.md)

***

### uname()

> **uname**(): [`SystemUname`](SystemUname.md)

#### Returns

[`SystemUname`](SystemUname.md)

***

### wake()

> **wake**(`deadline`, `due`): `void`

The engine's timers' nearest deadline, in milliseconds of CLOCK_MONOTONIC (null: none). The process's loop parks
no later than it, and calls `due` once it has come, from a turn of its own (no caller on the stack).

#### Parameters

##### deadline

`number` \| `null`

##### due

() => `void`

#### Returns

`void`
