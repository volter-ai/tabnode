[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ResolutionFs

# Interface: ResolutionFs

## Methods

### contentDigest()?

> `optional` **contentDigest**(`path`): `string` \| `undefined`

A regular file's content digest, or undefined where the tree holds none; asked only after `kindSync` said 0.

#### Parameters

##### path

`string`

#### Returns

`string` \| `undefined`

***

### existsSync()

> **existsSync**(`path`): `boolean`

#### Parameters

##### path

`string`

#### Returns

`boolean`

***

### kindSync()?

> `optional` **kindSync**(`path`): `0` \| `1` \| `-1` \| `undefined`

A path's kind where the filesystem answers it without a stat (KernelVirtualFS `kindSync`: its realm's kept
answer, links followed): 0 a file, 1 a directory, -1 proved absent; undefined where it cannot, and `statSync` is
asked as before. A probe answered here makes no Stats and no digest: a file's digest, wanted of the file a
resolution answers alone, is then asked of `contentDigest`.

#### Parameters

##### path

`string`

#### Returns

`0` \| `1` \| `-1` \| `undefined`

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

> **statSync**(`path`, `options?`): \{ `contentDigest?`: `string`; `isDirectory`: `boolean`; `isFile`: `boolean`; \} \| `undefined`

`contentDigest`: where the filesystem's stat carries it (a kernel tree's stat of a regular file, links followed,
KernelVirtualFS `statWithDigest`), the file's content digest from the same walk as the stat.
With throwIfNoEntry:false, only ENOENT/ENOTDIR return undefined. Permission/I/O failures still throw,
so the package-config cache never mistakes them for a persistent absence.

#### Parameters

##### path

`string`

##### options?

###### throwIfNoEntry?

`boolean`

#### Returns

\{ `contentDigest?`: `string`; `isDirectory`: `boolean`; `isFile`: `boolean`; \} \| `undefined`
