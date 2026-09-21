[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / Runtime

# Class: Runtime

Runtime class for executing code in virtual environment
Note: This class has sync methods for backward compatibility.
Use createRuntime() factory for IRuntime interface compliance.

## Constructors

### Constructor

> **new Runtime**(`vfs`, `options?`): `Runtime`

#### Parameters

##### vfs

[`VirtualFS`](VirtualFS.md)

##### options?

[`RuntimeOptions`](../interfaces/RuntimeOptions.md) = `{}`

#### Returns

`Runtime`

## Properties

### executeSync

> **executeSync**: (`code`, `filename`) => `object`

Execute code as a module (async version for IRuntime interface)
Alias: executeSync() is the same as execute() for backward compatibility

Execute code as a module (synchronous - backward compatible)

#### Parameters

##### code

`string`

##### filename?

`string` = `'/index.js'`

#### Returns

`object`

##### exports

> **exports**: `unknown`

##### module

> **module**: [`Module`](../interfaces/Module.md)

***

### runFileSync

> **runFileSync**: (`filename`) => `object`

Alias for runFile (backward compatibility)

Run a file from the virtual file system (synchronous - backward compatible)

#### Parameters

##### filename

`string`

#### Returns

`object`

##### exports

> **exports**: `unknown`

##### module

> **module**: [`Module`](../interfaces/Module.md)

## Methods

### clearCache()

> **clearCache**(): `void`

Clear the module cache

#### Returns

`void`

***

### createREPL()

> **createREPL**(): `object`

Create a REPL context that evaluates expressions and persists state.

Returns an object with an `eval` method that:
- Returns the value of the last expression (unlike `execute` which returns module.exports)
- Persists variables between calls (`var x = 1` then `x` works)
- Has access to `require`, `console`, `process`, `Buffer` (same as execute)

Security: The eval runs inside a Generator's local scope via direct eval,
NOT in the global scope. Only the runtime's own require/console/process are
exposed — the same sandbox boundary as execute(). Variables created in the
REPL are confined to the generator's closure and cannot leak to the page.

Note: `const`/`let` are transformed to `var` so they persist across calls
(var hoists to the generator's function scope, const/let are block-scoped
to each eval call and would be lost).

#### Returns

`object`

##### eval

> **eval**: (`code`) => `unknown`

###### Parameters

###### code

`string`

###### Returns

`unknown`

***

### execute()

> **execute**(`code`, `filename?`): `object`

Execute code as a module (synchronous - backward compatible)

#### Parameters

##### code

`string`

##### filename?

`string` = `'/index.js'`

#### Returns

`object`

##### exports

> **exports**: `unknown`

##### module

> **module**: [`Module`](../interfaces/Module.md)

***

### executeAsync()

> **executeAsync**(`code`, `filename?`): `Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

Execute code as a module (async - for IRuntime interface)

#### Parameters

##### code

`string`

##### filename?

`string` = `'/index.js'`

#### Returns

`Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

***

### getProcess()

> **getProcess**(): [`Process`](../interfaces/Process.md)

Get the process object

#### Returns

[`Process`](../interfaces/Process.md)

***

### getVFS()

> **getVFS**(): [`VirtualFS`](VirtualFS.md)

Get the virtual file system

#### Returns

[`VirtualFS`](VirtualFS.md)

***

### runFile()

> **runFile**(`filename`): `object`

Run a file from the virtual file system (synchronous - backward compatible)

#### Parameters

##### filename

`string`

#### Returns

`object`

##### exports

> **exports**: `unknown`

##### module

> **module**: [`Module`](../interfaces/Module.md)

***

### runFileAsync()

> **runFileAsync**(`filename`): `Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>

Run a file from the virtual file system (async - for IRuntime interface)

#### Parameters

##### filename

`string`

#### Returns

`Promise`\<[`IExecuteResult`](../interfaces/IExecuteResult.md)\>
