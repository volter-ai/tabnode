[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [module](../README.md) / Module

# Variable: Module

> `const` **Module**: `object`

## Type Declaration

### \_cache

> **\_cache**: `Record`\<`string`, `unknown`\>

### \_extensions

> **\_extensions**: `Record`\<`string`, `unknown`\>

### \_pathCache

> **\_pathCache**: `Record`\<`string`, `string`\>

### builtinModules

> **builtinModules**: `string`[]

### createRequire

> **createRequire**: (`filename`) => (`id`) => `unknown`

#### Parameters

##### filename

`string`

#### Returns

(`id`) => `unknown`

### isBuiltin

> **isBuiltin**: (`moduleName`) => `boolean`

#### Parameters

##### moduleName

`string`

#### Returns

`boolean`

### syncBuiltinESMExports

> **syncBuiltinESMExports**: () => `void`

#### Returns

`void`
