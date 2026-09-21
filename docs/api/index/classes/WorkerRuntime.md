[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / WorkerRuntime

# Class: WorkerRuntime

WorkerRuntime - Executes code in a Web Worker

## Implements

- [`IRuntime`](../interfaces/IRuntime.md)

## Constructors

### Constructor

> **new WorkerRuntime**(`vfs`, `options?`): `WorkerRuntime`

#### Parameters

##### vfs

[`VirtualFS`](VirtualFS.md)

##### options?

[`IRuntimeOptions`](../interfaces/IRuntimeOptions.md) = `{}`

#### Returns

`WorkerRuntime`

## Methods

### clearCache()

> **clearCache**(): `void`

Clear the module cache in the worker

#### Returns

`void`

#### Implementation of

[`IRuntime`](../interfaces/IRuntime.md).[`clearCache`](../interfaces/IRuntime.md#clearcache)

***

### execute()

> **execute**(`code`, `filename?`): `Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

Execute code in the worker

#### Parameters

##### code

`string`

##### filename?

`string`

#### Returns

`Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

#### Implementation of

[`IRuntime`](../interfaces/IRuntime.md).[`execute`](../interfaces/IRuntime.md#execute)

***

### getVFS()

> **getVFS**(): [`VirtualFS`](VirtualFS.md)

Get the VFS (main thread instance)

#### Returns

[`VirtualFS`](VirtualFS.md)

#### Implementation of

[`IRuntime`](../interfaces/IRuntime.md).[`getVFS`](../interfaces/IRuntime.md#getvfs)

***

### runFile()

> **runFile**(`filename`): `Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

Run a file from the VFS in the worker

#### Parameters

##### filename

`string`

#### Returns

`Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

#### Implementation of

[`IRuntime`](../interfaces/IRuntime.md).[`runFile`](../interfaces/IRuntime.md#runfile)

***

### terminate()

> **terminate**(): `void`

Terminate the worker

#### Returns

`void`

#### Implementation of

[`IRuntime`](../interfaces/IRuntime.md).[`terminate`](../interfaces/IRuntime.md#terminate)
