[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ContainerOptions

# Interface: ContainerOptions

## Extends

- [`RuntimeOptions`](RuntimeOptions.md)

## Properties

### baseUrl?

> `optional` **baseUrl?**: `string`

***

### cwd?

> `optional` **cwd?**: `string`

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`cwd`](RuntimeOptions.md#cwd)

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`env`](RuntimeOptions.md#env)

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

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`onConsole`](RuntimeOptions.md#onconsole)

***

### onServerReady?

> `optional` **onServerReady?**: (`port`, `url`) => `void`

#### Parameters

##### port

`number`

##### url

`string`

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

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`onStderr`](RuntimeOptions.md#onstderr)

***

### onStderrBytes?

> `optional` **onStderrBytes?**: (`bytes`) => `void`

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`onStderrBytes`](RuntimeOptions.md#onstderrbytes)

***

### onStdout?

> `optional` **onStdout?**: (`data`) => `void`

#### Parameters

##### data

`string`

#### Returns

`void`

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`onStdout`](RuntimeOptions.md#onstdout)

***

### onStdoutBytes?

> `optional` **onStdoutBytes?**: (`bytes`) => `void`

fd 1 and fd 2 as the bytes the program wrote; where given, the text sink of that fd is not called.

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`void`

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`onStdoutBytes`](RuntimeOptions.md#onstdoutbytes)

***

### pid?

> `optional` **pid?**: `number`

This run's process number and its parent's; minted where neither is given.

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`pid`](RuntimeOptions.md#pid)

***

### ppid?

> `optional` **ppid?**: `number`

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`ppid`](RuntimeOptions.md#ppid)

***

### stdin?

> `optional` **stdin?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What is on the guest's fd 0, the way a shell puts the left of a pipe there.

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`stdin`](RuntimeOptions.md#stdin)

***

### stdinHeld?

> `optional` **stdinHeld?**: `boolean`

The runner can still write to fd 0, so standard input has not ended.

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`stdinHeld`](RuntimeOptions.md#stdinheld)

***

### tty?

> `optional` **tty?**: `boolean` \| readonly \[`boolean`, `boolean`, `boolean`\]

The run was given a TTY, on all three fds or per fd as `[stdin, stdout, stderr]`; a pipe child is not one.

#### Inherited from

[`RuntimeOptions`](RuntimeOptions.md).[`tty`](RuntimeOptions.md#tty)

***

### vfs?

> `optional` **vfs?**: [`VirtualFS`](../classes/VirtualFS.md)

The filesystem the container runs on; one is built in memory when absent.
