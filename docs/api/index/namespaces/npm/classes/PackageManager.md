[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [npm](../README.md) / PackageManager

# Class: PackageManager

npm Package Manager for VirtualFS

## Constructors

### Constructor

> **new PackageManager**(`vfs`, `options?`): `PackageManager`

#### Parameters

##### vfs

[`VirtualFS`](../../../classes/VirtualFS.md)

##### options?

`object` & [`RegistryOptions`](../interfaces/RegistryOptions.md) = `{}`

#### Returns

`PackageManager`

## Methods

### install()

> **install**(`packageSpec`, `options?`): `Promise`\<[`InstallResult`](../interfaces/InstallResult.md)\>

Install a package and its dependencies

#### Parameters

##### packageSpec

`string`

##### options?

[`InstallOptions`](../interfaces/InstallOptions.md) = `{}`

#### Returns

`Promise`\<[`InstallResult`](../interfaces/InstallResult.md)\>

***

### installFromPackageJson()

> **installFromPackageJson**(`options?`): `Promise`\<[`InstallResult`](../interfaces/InstallResult.md)\>

Install all dependencies from package.json

#### Parameters

##### options?

[`InstallOptions`](../interfaces/InstallOptions.md) = `{}`

#### Returns

`Promise`\<[`InstallResult`](../interfaces/InstallResult.md)\>

***

### list()

> **list**(): `Record`\<`string`, `string`\>

List installed packages

#### Returns

`Record`\<`string`, `string`\>
