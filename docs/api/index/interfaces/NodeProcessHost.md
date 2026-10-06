[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NodeProcessHost

# Interface: NodeProcessHost

## Methods

### run()

> **run**(`launch`): `Promise`\<\{ `exitCode`: `number`; `signal?`: `string`; `stderr`: `string`; `stdout`: `string`; \}\>

`signal` names the signal whose default action ended the process, as
Node's exit event does. Where `launch.streams` carries `onStdoutBytes` /
`onStderrBytes`, the host writes that fd's output there as bytes, and the
fd's total in the answer is empty: the engine never replays or decodes an
fd that streamed bytes. A text-only host writes `onStdout`/`onStderr` and
answers text totals, as before.

#### Parameters

##### launch

[`NodeProcessLaunch`](NodeProcessLaunch.md)

#### Returns

`Promise`\<\{ `exitCode`: `number`; `signal?`: `string`; `stderr`: `string`; `stdout`: `string`; \}\>
