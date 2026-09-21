[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / createFsShim

# Function: createFsShim()

> **createFsShim**(`tree`, `_getCwd?`): `__module`

Node's `fs` is an ordinary module object, and a program may define on it:
`graceful-fs` -- which half of npm loads, openvscode-server through
`fs-extra` and `@vscode/deviceid` -- writes its queue onto the module with
`Object.defineProperty(fs, Symbol.for('graceful-fs.queue'), { get() {…} })`
and then clones the module, which walks its keys. Every trap below read the
module and none read the proxy's own target, so a guest's define landed
where nothing looked: the read came back `undefined`, `key in fs` answered
false for a key the target held non-configurable, and `Reflect.ownKeys(fs)`
threw `'ownKeys' on proxy: trap result did not include
'Symbol(graceful-fs.queue)'` -- a proxy may not hide a non-configurable own
key of its target. graceful-fs threw out of its own module load, and every
program that loads it died there: in the substrate's tab that was
openvscode-server's server at boot and its extension host, which exited 1
without a word because a forked host's console goes to its parent over IPC.

What a guest writes is the guest's, and what it did not write is the
module's; the guest global's proxy in `src/runtime.ts` answers the same way.

## Parameters

### tree

[`VirtualFS`](../classes/VirtualFS.md)

### \_getCwd?

() => `string`

## Returns

`__module`
