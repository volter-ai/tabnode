[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / createRuntime

# Function: createRuntime()

> **createRuntime**(`vfs`, `options?`): `Promise`\<[`IRuntime`](../interfaces/IRuntime.md)\>

Create a runtime on the thread the options name.

`useWorker` puts the guest on a worker of the engine's own, `'auto'` does
so where the realm has workers, and the default runs it on the caller's
thread behind the same asynchronous interface.

## Parameters

### vfs

[`VirtualFS`](../classes/VirtualFS.md)

### options?

[`CreateRuntimeOptions`](../interfaces/CreateRuntimeOptions.md) = `{}`

## Returns

`Promise`\<[`IRuntime`](../interfaces/IRuntime.md)\>
