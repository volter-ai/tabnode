[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / RuntimeOptions

# Interface: RuntimeOptions

## Extended by

- [`ContainerOptions`](ContainerOptions.md)

## Properties

### credentials?

> `optional` **credentials?**: [`ProcessCredentials`](ProcessCredentials.md)

Host-configured numeric identity; absent preserves uid/gid 1000 and groups [1000].

***

### cwd?

> `optional` **cwd?**: `string`

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

***

### httpParserModule?

> `optional` **httpParserModule?**: `Module`

llhttp compiled by the creating worker; structured-cloned into the guest realm.

***

### moduleEvaluationObserver?

> `optional` **moduleEvaluationObserver?**: [`ModuleEvaluationObserver`](ModuleEvaluationObserver.md)

Observe only original completed synchronous bodies at these exact paths, when the host explicitly requests it.

***

### onConsole?

> `optional` **onConsole?**: (`method`, `args`) => `void`

#### Parameters

##### method

`string`

##### args

`unknown`[]

#### Returns

`void`

***

### onStderr?

> `optional` **onStderr?**: (`data`) => `void`

#### Parameters

##### data

`string`

#### Returns

`void`

***

### onStderrBytes?

> `optional` **onStderrBytes?**: (`bytes`) => `void`

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`

***

### onStdout?

> `optional` **onStdout?**: (`data`) => `void`

#### Parameters

##### data

`string`

#### Returns

`void`

***

### onStdoutBytes?

> `optional` **onStdoutBytes?**: (`bytes`) => `void`

fd 1 and fd 2 as the bytes the program wrote; where given, the text sink of that fd is not called.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`

***

### pid?

> `optional` **pid?**: `number`

This run's process number and its parent's; minted where neither is given.

***

### ppid?

> `optional` **ppid?**: `number`

***

### stdin?

> `optional` **stdin?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What is on the guest's fd 0, the way a shell puts the left of a pipe there.

***

### stdinHeld?

> `optional` **stdinHeld?**: `boolean`

The runner can still write to fd 0, so standard input has not ended.

***

### tty?

> `optional` **tty?**: `boolean` \| readonly \[`boolean`, `boolean`, `boolean`\]

The run was given a TTY, on all three fds or per fd as `[stdin, stdout, stderr]`; a pipe child is not one.
