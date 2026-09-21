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

#### onStdout?

(`data`) => `void`

#### pid?

`number`

This process's own number and its parent's, as Node gives every process.

#### ppid?

`number`

#### stdin?

`string`

What the runner put on the guest's fd 0, as a shell puts the left of a pipe there.

#### stdinHeld?

`boolean`

The runner can still write to the guest's fd 0 (a held run fed with
`sendStdin`), so standard input does not end when the guest starts. Node's
pipe whose writer has not closed: the stream stays open and empty.

#### tty?

`boolean`

The run was given a TTY. A pipe (a spawned child, a cell that is not
held) is not one: Node does not inherit FORCE_COLOR onto a pipe, and
`util.inspect` of an Error would colorize a stack and then ask
`BuiltinModule.exists` of every `node:` frame.

## Returns

[`Process`](../interfaces/Process.md)
