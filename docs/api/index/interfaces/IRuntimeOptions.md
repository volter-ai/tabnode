[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / IRuntimeOptions

# Interface: IRuntimeOptions

## Extended by

- [`CreateRuntimeOptions`](CreateRuntimeOptions.md)

## Properties

### credentials?

> `optional` **credentials?**: [`ProcessCredentials`](ProcessCredentials.md)

Host-configured numeric identity; absent preserves uid/gid 1000 and groups [1000].

***

### cwd?

> `optional` **cwd?**: `string`

***

### env?

> `optional` **env?**: `Record`\<`string`, `string`\>

***

### httpParserModule?

> `optional` **httpParserModule?**: `Module`

llhttp compiled by the creating worker; structured-cloned into the guest realm.

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
