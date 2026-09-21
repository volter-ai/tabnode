[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / Process

# Interface: Process

## Properties

### addListener

> **addListener**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### arch?

> `optional` **arch?**: `string`

***

### argv

> **argv**: `string`[]

***

### argv0

> **argv0**: `string`

***

### assert

> **assert**: (`value`, `message?`) => `void`

Node's deprecated `process.assert`: assert.ok.

#### Parameters

##### value

`unknown`

##### message?

`string`

#### Returns

`void`

***

### availableMemory

> **availableMemory**: () => `number`

Node's `process.availableMemory`: the memory still free, from the same place `os.freemem` reads.

#### Returns

`number`

***

### binding

> **binding**: (`name`) => `unknown`

Node's deprecated `process.binding`, which bundles still feature-detect through.

#### Parameters

##### name

`string`

#### Returns

`unknown`

***

### chdir

> **chdir**: (`directory`) => `void`

#### Parameters

##### directory

`string`

#### Returns

`void`

***

### config

> **config**: `object`

Node's `process.config`: how the binary was built.

#### target\_defaults

> **target\_defaults**: `Record`\<`string`, `unknown`\>

#### variables

> **variables**: `Record`\<`string`, `unknown`\>

***

### connected?

> `optional` **connected?**: `boolean`

***

### constrainedMemory

> **constrainedMemory**: () => `number`

Node's `process.constrainedMemory`: a cgroup's limit, 0 when there is none.

#### Returns

`number`

***

### cpuUsage

> **cpuUsage**: () => `object`

#### Returns

`object`

##### system

> **system**: `number`

##### user

> **user**: `number`

***

### cwd

> **cwd**: () => `string`

#### Returns

`string`

***

### emit

> **emit**: (`event`, ...`args`) => `boolean`

#### Parameters

##### event

`string`

##### args

...`unknown`[]

#### Returns

`boolean`

***

### emitWarning

> **emitWarning**: (`warning`, ...`rest`) => `void`

Node's `process.emitWarning`, which fs-extra calls on its way into every
 React Router build; a warning goes to stderr the way Node prints one.

#### Parameters

##### warning

`string` \| `Error`

##### rest

...`unknown`[]

#### Returns

`void`

***

### env

> **env**: [`ProcessEnv`](ProcessEnv.md)

***

### eventNames

> **eventNames**: () => (`string` \| `symbol`)[]

#### Returns

(`string` \| `symbol`)[]

***

### execArgv

> **execArgv**: `string`[]

***

### execPath

> **execPath**: `string`

***

### exit

> **exit**: (`code?`) => `never`

#### Parameters

##### code?

`number`

#### Returns

`never`

***

### exitCode?

> `optional` **exitCode?**: `number`

What a script that returned without calling `exit` exits with.

***

### features

> **features**: `Record`\<`string`, `boolean` \| `string` \| `undefined`\>

Node's `process.features`: what the binary was built with.

***

### getMaxListeners

> **getMaxListeners**: () => `number`

#### Returns

`number`

***

### hasUncaughtExceptionCaptureCallback

> **hasUncaughtExceptionCaptureCallback**: () => `boolean`

#### Returns

`boolean`

***

### hrtime

> **hrtime**: \{(`time?`): \[`number`, `number`\]; `bigint`: () => `bigint`; \}

#### Parameters

##### time?

\[`number`, `number`\]

#### Returns

\[`number`, `number`\]

#### bigint

> **bigint**: () => `bigint`

##### Returns

`bigint`

***

### kill

> **kill**: (`pid`, `signal?`) => `boolean`

Node's `process.kill`, raising a signal on the guest's own process.

#### Parameters

##### pid

`number`

##### signal?

`string` \| `number`

#### Returns

`boolean`

***

### listenerCount

> **listenerCount**: (`event`) => `number`

#### Parameters

##### event

`string`

#### Returns

`number`

***

### listeners

> **listeners**: (`event`) => `EventListener`[]

#### Parameters

##### event

`string`

#### Returns

`EventListener`[]

***

### memoryUsage

> **memoryUsage**: () => `object`

#### Returns

`object`

##### arrayBuffers

> **arrayBuffers**: `number`

##### external

> **external**: `number`

##### heapTotal

> **heapTotal**: `number`

##### heapUsed

> **heapUsed**: `number`

##### rss

> **rss**: `number`

***

### moduleLoadList

> **moduleLoadList**: `string`[]

Node's `process.moduleLoadList`: every builtin this process has loaded,
in the order it first loaded each, as `NativeModule <id>`. A program reads
it to tell whether a module is already in memory before it does something
that would pull it in; Node's own tests read it that way.

***

### nextTick

> **nextTick**: (`callback`, ...`args`) => `void`

#### Parameters

##### callback

(...`args`) => `void`

##### args

...`unknown`[]

#### Returns

`void`

***

### off

> **off**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### on

> **on**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### once

> **once**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### pid

> **pid**: `number`

***

### platform

> **platform**: `string`

***

### ppid

> **ppid**: `number`

***

### prependListener

> **prependListener**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### prependOnceListener

> **prependOnceListener**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### removeAllListeners

> **removeAllListeners**: (`event?`) => `Process`

#### Parameters

##### event?

`string`

#### Returns

`Process`

***

### removeListener

> **removeListener**: (`event`, `listener`) => `Process`

#### Parameters

##### event

`string`

##### listener

`EventListener`

#### Returns

`Process`

***

### send?

> `optional` **send?**: (`message`, `callback?`) => `boolean`

#### Parameters

##### message

`unknown`

##### callback?

(`error`) => `void`

#### Returns

`boolean`

***

### setMaxListeners

> **setMaxListeners**: (`n`) => `Process`

#### Parameters

##### n

`number`

#### Returns

`Process`

***

### setUncaughtExceptionCaptureCallback

> **setUncaughtExceptionCaptureCallback**: (`callback`) => `void`

Node's uncaught-exception capture pair. A program that sets a callback
takes every uncaught exception instead of the `uncaughtException` event,
and `domain` asks whether one is set before it installs its own handling.

#### Parameters

##### callback

((`error`) => `void`) \| `null`

#### Returns

`void`

***

### stderr

> **stderr**: `ProcessWritableStream`

***

### stdin

> **stdin**: `ProcessStdin`

***

### stdout

> **stdout**: `ProcessWritableStream`

***

### umask

> **umask**: (`mask?`) => `number`

Node's `process.umask()`: the file-mode mask this process creates with.

#### Parameters

##### mask?

`string` \| `number`

#### Returns

`number`

***

### uptime

> **uptime**: () => `number`

#### Returns

`number`

***

### version

> **version**: `string`

***

### versions

> **versions**: `object`

#### node

> **node**: `string`

#### openssl?

> `optional` **openssl?**: `string`

#### uv

> **uv**: `string`

#### v8

> **v8**: `string`

#### webcontainer?

> `optional` **webcontainer?**: `string`
