[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [path](../README.md) / PlatformPath

# Interface: PlatformPath

## Properties

### delimiter

> `readonly` **delimiter**: `string`

***

### posix

> `readonly` **posix**: `PlatformPath`

***

### sep

> `readonly` **sep**: `string`

***

### win32

> `readonly` **win32**: `PlatformPath`

## Methods

### \_makeLong()

> **\_makeLong**\<`T`\>(`path`): `T`

#### Type Parameters

##### T

`T`

#### Parameters

##### path

`T`

#### Returns

`T`

***

### basename()

> **basename**(`path`, `suffix?`): `string`

#### Parameters

##### path

`string`

##### suffix?

`string`

#### Returns

`string`

***

### dirname()

> **dirname**(`path`): `string`

#### Parameters

##### path

`string`

#### Returns

`string`

***

### extname()

> **extname**(`path`): `string`

#### Parameters

##### path

`string`

#### Returns

`string`

***

### format()

> **format**(`pathObject`): `string`

#### Parameters

##### pathObject

[`FormatInputPathObject`](FormatInputPathObject.md)

#### Returns

`string`

***

### isAbsolute()

> **isAbsolute**(`path`): `boolean`

#### Parameters

##### path

`string`

#### Returns

`boolean`

***

### join()

> **join**(...`paths`): `string`

#### Parameters

##### paths

...`string`[]

#### Returns

`string`

***

### matchesGlob()

> **matchesGlob**(`path`, `pattern`): `boolean`

#### Parameters

##### path

`string`

##### pattern

`string`

#### Returns

`boolean`

***

### normalize()

> **normalize**(`path`): `string`

#### Parameters

##### path

`string`

#### Returns

`string`

***

### parse()

> **parse**(`path`): [`ParsedPath`](ParsedPath.md)

#### Parameters

##### path

`string`

#### Returns

[`ParsedPath`](ParsedPath.md)

***

### relative()

> **relative**(`from`, `to`): `string`

#### Parameters

##### from

`string`

##### to

`string`

#### Returns

`string`

***

### resolve()

> **resolve**(...`paths`): `string`

#### Parameters

##### paths

...`string`[]

#### Returns

`string`

***

### toNamespacedPath()

> **toNamespacedPath**\<`T`\>(`path`): `T`

#### Type Parameters

##### T

`T`

#### Parameters

##### path

`T`

#### Returns

`T`
