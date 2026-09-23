[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NodeProcessLaunch

# Interface: NodeProcessLaunch

Trusted launch data, before Node options or the script execute in a realm.

## Properties

### argv

> **argv**: readonly `string`[]

Arguments after the Node executable, preserving each parsed word.

***

### cwd

> **cwd**: `string`

***

### env

> **env**: `Record`\<`string`, `string`\>

***

### filesystem

> **filesystem**: [`VirtualFS`](../classes/VirtualFS.md)

This entry's filesystem view, including any host-prepared entry wrapper.

***

### identity

> **identity**: [`ProcessIdentity`](ProcessIdentity.md)

***

### inherited

> **inherited**: readonly `object`[]

***

### stdin?

> `optional` **stdin?**: `string`

***

### stdinStream?

> `optional` **stdinStream?**: `AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>, `any`, `any`\>

***

### streams?

> `optional` **streams?**: `RunStreams`

***

### token

> **token**: `string`
