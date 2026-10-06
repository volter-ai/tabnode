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

### filesystem?

> `optional` **filesystem?**: [`VirtualFS`](../classes/VirtualFS.md)

The tree this run's Node reads and writes, in place of the container's
own: a host's tree for one process (a kernel's, for a `node` its shell
exec'd), chosen per run, while the run keeps the container's one port
space, process table and servers, as a process on Linux keeps its
network namespace whatever filesystem it sees. The engine writes nothing
into it on its own account. `runNode` only.

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

### onStderrBytes?

> `optional` **onStderrBytes?**: (`bytes`) => `void`

fd 2 as bytes, as `onStdoutBytes` is fd 1.

#### Parameters

##### bytes

`Uint8Array`

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

### onStdoutBytes?

> `optional` **onStdoutBytes?**: (`bytes`) => `void`

The guest Node's fd 1 as bytes: each write's bytes exactly as the program
wrote them, before any decode, as a file or pipe on fd 1 receives them.
Where given, `onStdout` is not called for that fd and `RunResult.stdout`
is empty: nothing of it is kept as text.

#### Parameters

##### bytes

`Uint8Array`

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

> `optional` **stdin?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What is on fd 0 when the run begins, so a builtin reads what was piped to
it. `runNode` gives bytes to Node as they are; `run`'s shell reads its
input as text, and bytes given to it are read as UTF-8.

***

### stdinShared?

> `optional` **stdinShared?**: `SharedArrayBuffer`

The guest Node's fd 0 as a shared ring a host writes from a thread of its
own (`STDIN_RING` says the layout; `createStdinRing` makes one). Where
given it is fd 0's only source: `stdin`, `stdinStream` and `sendInput` are
not read for the run, a blocking `fs.readSync(0)` waits on it, and
`process.stdin` drains it through `Atomics.waitAsync`, which the realm
must have.

***

### stdinStream?

> `optional` **stdinStream?**: `AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>, `any`, `any`\>

***

### stdioIsTTY?

> `optional` **stdioIsTTY?**: readonly \[`boolean`, `boolean`, `boolean`\]

Which of the guest Node's fds 0, 1 and 2 is a terminal, as `isatty` answers
for each: `node x > out.log` at a terminal is `[true, false, true]`. Absent,
a `held` run or one given a `terminal` is a terminal on all three, and
any other is a pipe on all three. `terminal` still gives the size, which
reaches the output fds that are terminals.

***

### stdioKind?

> `optional` **stdioKind?**: readonly \[[`StdioKind`](../type-aliases/StdioKind.md), [`StdioKind`](../type-aliases/StdioKind.md), [`StdioKind`](../type-aliases/StdioKind.md)\]

What each of the guest Node's fds 0, 1 and 2 is, as the kernel's
description says: a terminal, a pipe, a file (a `<` or `>` redirect), or
a character device that is not a terminal ('char', `/dev/null`). `fstat`
answers by it, only a 'tty' fd is a terminal to `isatty`, and
`guessHandleType` answers as libuv does ('TTY', 'PIPE', or 'FILE' for a
file or a character device). Where given, `stdioIsTTY` is not read.

***

### terminal?

> `optional` **terminal?**: `object`

#### columns

> **columns**: `number`

#### onResize?

> `optional` **onResize?**: (`listener`) => () => `void`

##### Parameters

###### listener

(`columns`, `rows`) => `void`

##### Returns

() => `void`

#### rows

> **rows**: `number`
