[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / IRuntime

# Interface: IRuntime

Common runtime interface implemented by both MainThreadRuntime and WorkerRuntime

## Methods

### clearCache()

> **clearCache**(): `void`

Clear the module cache

#### Returns

`void`

***

### execute()

> **execute**(`code`, `filename?`): `Promise`\<[`IExecuteResult`](IExecuteResult.md)\>

Execute code as a module

#### Parameters

##### code

`string`

##### filename?

`string`

#### Returns

`Promise`\<[`IExecuteResult`](IExecuteResult.md)\>

***

### getVFS()?

> `optional` **getVFS**(): [`VirtualFS`](../classes/VirtualFS.md)

Get the virtual file system (only available on main thread runtime)

#### Returns

[`VirtualFS`](../classes/VirtualFS.md)

***

### runFile()

> **runFile**(`filename`): `Promise`\<[`IExecuteResult`](IExecuteResult.md)\>

Run a file from the virtual file system

#### Parameters

##### filename

`string`

#### Returns

`Promise`\<[`IExecuteResult`](IExecuteResult.md)\>

***

### terminate()?

> `optional` **terminate**(): `void`

Terminate the runtime (only applicable to worker runtime)

#### Returns

`void`
