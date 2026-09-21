[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ExportsResolver

# Interface: ExportsResolver

## Methods

### imports()

> **imports**(`pkg`, `entry`, `options?`): `string` \| `void` \| `string`[]

#### Parameters

##### pkg

`unknown`

##### entry

`string`

##### options?

###### browser?

`boolean`

###### conditions?

readonly `string`[]

###### require?

`boolean`

###### unsafe?

`boolean`

#### Returns

`string` \| `void` \| `string`[]

***

### resolve()

> **resolve**(`pkg`, `entry`, `options?`): `string` \| `void` \| `string`[]

`resolve.exports`'s `resolve(pkg, entry, options)`: package exports or imports, by conditions.

#### Parameters

##### pkg

`unknown`

##### entry

`string`

##### options?

###### browser?

`boolean`

###### conditions?

readonly `string`[]

###### require?

`boolean`

###### unsafe?

`boolean`

#### Returns

`string` \| `void` \| `string`[]
