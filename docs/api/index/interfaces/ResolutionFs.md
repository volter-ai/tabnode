[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ResolutionFs

# Interface: ResolutionFs

## Methods

### existsSync()

> **existsSync**(`path`): `boolean`

#### Parameters

##### path

`string`

#### Returns

`boolean`

***

### readFileSync()

> **readFileSync**(`path`, `encoding`): `string` \| `Uint8Array`\<`ArrayBufferLike`\>

#### Parameters

##### path

`string`

##### encoding

`"utf8"`

#### Returns

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

***

### realpathSync()?

> `optional` **realpathSync**(`path`): `string`

#### Parameters

##### path

`string`

#### Returns

`string`

***

### statSync()

> **statSync**(`path`, `options?`): \{ `isDirectory`: `boolean`; `isFile`: `boolean`; \} \| `undefined`

#### Parameters

##### path

`string`

##### options?

###### throwIfNoEntry?

`boolean`

#### Returns

\{ `isDirectory`: `boolean`; `isFile`: `boolean`; \} \| `undefined`
