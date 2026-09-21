[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [npm](../README.md) / Registry

# Class: Registry

## Constructors

### Constructor

> **new Registry**(`options?`): `Registry`

#### Parameters

##### options?

[`RegistryOptions`](../interfaces/RegistryOptions.md) = `{}`

#### Returns

`Registry`

## Properties

### registryScopes?

> `optional` **registryScopes?**: `Record`\<`string`, `string`\>

***

### registryUrl

> **registryUrl**: `string`

## Methods

### clearCache()

> **clearCache**(): `void`

Clear the cache

#### Returns

`void`

***

### downloadTarball()

> **downloadTarball**(`tarballUrl`): `Promise`\<`ArrayBuffer`\>

Download tarball as ArrayBuffer

#### Parameters

##### tarballUrl

`string`

#### Returns

`Promise`\<`ArrayBuffer`\>

***

### getLatestVersion()

> **getLatestVersion**(`packageName`): `Promise`\<`string`\>

Get latest version number

#### Parameters

##### packageName

`string`

#### Returns

`Promise`\<`string`\>

***

### getPackageManifest()

> **getPackageManifest**(`packageName`): `Promise`\<[`PackageManifest`](../interfaces/PackageManifest.md)\>

Fetch package manifest (all versions metadata)

#### Parameters

##### packageName

`string`

#### Returns

`Promise`\<[`PackageManifest`](../interfaces/PackageManifest.md)\>

***

### getPackageVersion()

> **getPackageVersion**(`packageName`, `version`): `Promise`\<[`PackageVersion`](../interfaces/PackageVersion.md)\>

Get specific version metadata

#### Parameters

##### packageName

`string`

##### version

`string`

#### Returns

`Promise`\<[`PackageVersion`](../interfaces/PackageVersion.md)\>

***

### getVersions()

> **getVersions**(`packageName`): `Promise`\<`string`[]\>

Get all available versions

#### Parameters

##### packageName

`string`

#### Returns

`Promise`\<`string`[]\>

***

### registryFor()

> **registryFor**(`packageName`): `string`

Which registry answers for a name: the one its scope is served from,
or the one its whole name is, and otherwise the default.

A project may carry packages of its own that no public registry has: a
private SDK, a twin, a package built in the same workspace but never
published. Asking one registry for every name meant npm answered 404 for
the scope and the install failed with nothing the project could do short
of publishing.

#### Parameters

##### packageName

`string`

#### Returns

`string`
