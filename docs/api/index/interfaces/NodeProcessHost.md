[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / NodeProcessHost

# Interface: NodeProcessHost

## Methods

### run()

> **run**(`launch`): `Promise`\<\{ `exitCode`: `number`; `signal?`: `string`; `stderr`: `string`; `stdout`: `string`; \}\>

`signal` names the signal whose default action ended the process, as Node's exit event does.

#### Parameters

##### launch

[`NodeProcessLaunch`](NodeProcessLaunch.md)

#### Returns

`Promise`\<\{ `exitCode`: `number`; `signal?`: `string`; `stderr`: `string`; `stdout`: `string`; \}\>
