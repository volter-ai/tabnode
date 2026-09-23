[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / createContainer

# Function: createContainer()

> **createContainer**(`options?`): `object`

Create a new WebContainer-like environment

## Parameters

### options?

[`ContainerOptions`](../interfaces/ContainerOptions.md)

## Returns

### createREPL

> **createREPL**: () => `object`

#### Returns

`object`

##### eval

> **eval**: (`code`) => `unknown`

###### Parameters

###### code

`string`

###### Returns

`unknown`

### currentProcessToken

> **currentProcessToken**: () => `string` \| `null`

The run whose guest code is executing, for a caller attributing a child.

#### Returns

`string` \| `null`

### execute

> **execute**: (`code`, `filename?`) => `object`

#### Parameters

##### code

`string`

##### filename?

`string`

#### Returns

`object`

##### exports

> **exports**: `unknown`

### listenNet

> **listenNet**: (`port`, `onConnection`) => () => `void`

#### Parameters

##### port

`number`

##### onConnection

(`socket`) => `void`

#### Returns

() => `void`

### npm

> **npm**: [`PackageManager`](../namespaces/npm/classes/PackageManager.md)

### on

> **on**: (`event`, `listener`) => `void`

#### Parameters

##### event

`string`

##### listener

(...`args`) => `void`

#### Returns

`void`

### pendingTimers

> **pendingTimers**: (`token`) => `number`

#### Parameters

##### token

`string`

#### Returns

`number`

### portPid

> **portPid**: (`port`) => `number` \| `undefined`

The pid of the process listening on a port of this engine, where a guest process is: `/proc`'s socket owner.

#### Parameters

##### port

`number`

#### Returns

`number` \| `undefined`

### processByPid

> **processByPid**: (`pid`) => \{ `pid`: `number`; `ppid`: `number`; \} \| `undefined`

The numbers a live process carries, looked up by its own pid.

#### Parameters

##### pid

`number`

#### Returns

\{ `pid`: `number`; `ppid`: `number`; \} \| `undefined`

### processPorts

> **processPorts**: (`token`) => `number`[]

#### Parameters

##### token

`string`

#### Returns

`number`[]

### run

> **run**: (`command`, `options?`) => `Promise`\<[`RunResult`](../interfaces/RunResult.md)\>

#### Parameters

##### command

`string`

##### options?

[`RunOptions`](../interfaces/RunOptions.md)

#### Returns

`Promise`\<[`RunResult`](../interfaces/RunResult.md)\>

### runFile

> **runFile**: (`filename`) => `object`

#### Parameters

##### filename

`string`

#### Returns

`object`

##### exports

> **exports**: `unknown`

### runPid

> **runPid**: (`token?`) => \{ `pid`: `number`; `ppid`: `number`; \} \| `undefined`

The numbers a named run, or the current one, was started with.

#### Parameters

##### token?

`string` \| `null`

#### Returns

\{ `pid`: `number`; `ppid`: `number`; \} \| `undefined`

### runtime

> **runtime**: [`Runtime`](../classes/Runtime.md)

### sendInput

> **sendInput**: (`data`, `token?`) => `void`

Input for one run's guest, by its process token; without a token, the most
recently started held run, which is the prompt a person is typing to.

#### Parameters

##### data

`string`

##### token?

`string`

#### Returns

`void`

### serverBridge

> **serverBridge**: [`ServerBridge`](../classes/ServerBridge.md)

### signalProcess

> **signalProcess**: (`token`, `signal`) => `boolean`

Deliver a signal to the named run as another process's `kill(pid)` does; false when the run is gone.

#### Parameters

##### token

`string`

##### signal

`string`

#### Returns

`boolean`

### stopProcess

> **stopProcess**: (`token`) => `boolean`

#### Parameters

##### token

`string`

#### Returns

`boolean`

### vfs

> **vfs**: [`VirtualFS`](../classes/VirtualFS.md)
