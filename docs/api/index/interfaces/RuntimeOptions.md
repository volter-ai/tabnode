[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / RuntimeOptions

# Interface: RuntimeOptions

## Extended by

- [`ContainerOptions`](ContainerOptions.md)

## Properties

### cwd?

> `optional` **cwd?**: `string`

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

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

### onStdout?

> `optional` **onStdout?**: (`data`) => `void`

#### Parameters

##### data

`string`

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

> `optional` **stdin?**: `string`

What is on the guest's fd 0, the way a shell puts the left of a pipe there.

***

### stdinHeld?

> `optional` **stdinHeld?**: `boolean`

The runner can still write to fd 0, so standard input has not ended.

***

### tty?

> `optional` **tty?**: `boolean`

The run was given a TTY; a pipe child is not one.
