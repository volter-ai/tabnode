[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / RunOptions

# Interface: RunOptions

## Properties

### cwd?

> `optional` **cwd?**: `string`

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

The environment the command runs in, as `child_process.exec` takes it.

***

### held?

> `optional` **held?**: `boolean`

The host keeps this run open (a watch or an interactive shell); a run that
is not held ends when its loop has nothing left, as Node's does. A
`signal` alone is an abort handle, not a hold.

***

### onStderr?

> `optional` **onStderr?**: (`data`) => `void`

Callback for streaming stderr chunks as they arrive

#### Parameters

##### data

`string`

#### Returns

`void`

***

### onStdout?

> `optional` **onStdout?**: (`data`) => `void`

Callback for streaming stdout chunks as they arrive (for long-running commands like vitest watch)

#### Parameters

##### data

`string`

#### Returns

`void`

***

### processToken?

> `optional` **processToken?**: `string`

A name for this run. The `node` command records the guest process it
creates under it for the run's lifetime, and the container answers
`pendingTimers`, `processPorts` and `stopProcess` about that name.

***

### signal?

> `optional` **signal?**: `AbortSignal`

AbortSignal to cancel long-running commands

***

### stdin?

> `optional` **stdin?**: `string`

What the shell reads on stdin, so a builtin reads what was piped to it.
