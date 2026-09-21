[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / CreateRuntimeOptions

# Interface: CreateRuntimeOptions

Options for creating a runtime

## Extends

- [`IRuntimeOptions`](IRuntimeOptions.md)

## Properties

### cwd?

> `optional` **cwd?**: `string`

#### Inherited from

[`IRuntimeOptions`](IRuntimeOptions.md).[`cwd`](IRuntimeOptions.md#cwd)

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

#### Inherited from

[`IRuntimeOptions`](IRuntimeOptions.md).[`env`](IRuntimeOptions.md#env)

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

[`IRuntimeOptions`](IRuntimeOptions.md).[`onConsole`](IRuntimeOptions.md#onconsole)

***

### useWorker?

> `optional` **useWorker?**: `boolean` \| `"auto"`

Which thread the guest runs on.
- false (default): the caller's thread
- true: a worker of the engine's own
- 'auto': a worker where the realm has them, the caller's thread otherwise

A worker is a thread, not an origin: it reaches the page's storage and
its network. An embedder that needs origin isolation serves the run from
an origin of its own, which is the substrate's isolation worker.
