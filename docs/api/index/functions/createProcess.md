[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / createProcess

# Function: createProcess()

> **createProcess**(`options?`): [`Process`](../interfaces/Process.md)

## Parameters

### options?

#### cwd?

`string`

#### env?

[`ProcessEnv`](../interfaces/ProcessEnv.md)

#### onExit?

(`code`) => `void`

#### onStderr?

(`data`) => `void`

#### onStderrBytes?

(`bytes`) => `void`

#### onStdout?

(`data`) => `void`

#### onStdoutBytes?

(`bytes`) => `void`

fd 1 and fd 2 as bytes: every write's chunk exactly as the program wrote
it, before any decode, as a file or pipe receives it. Where given, the
text sink of the same fd is not called.

#### pid?

`number`

This process's own number and its parent's, as Node gives every process.

#### ppid?

`number`

#### stdin?

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

What the runner put on the guest's fd 0, as a shell puts the left of a pipe there.

#### stdinHeld?

`boolean`

The runner can still write to the guest's fd 0 (a held run fed with
`sendStdin`), so standard input does not end when the guest starts. Node's
pipe whose writer has not closed: the stream stays open and empty.

#### tty?

`boolean` \| readonly \[`boolean`, `boolean`, `boolean`\]

The run was given a TTY. A pipe (a spawned child, a cell that is not
held) is not one: Node does not inherit FORCE_COLOR onto a pipe, and
`util.inspect` of an Error would colorize a stack and then ask
`BuiltinModule.exists` of every `node:` frame.

One flag for all three, or one per fd as `[stdin, stdout, stderr]`:
`node x > out.log` at a terminal has fd 1 a file and fd 0 and 2 the
terminal.

## Returns

[`Process`](../interfaces/Process.md)
