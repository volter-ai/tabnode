[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeDescriptors

# Interface: TreeDescriptors

The descriptor operations of a tree that owns its descriptions. Each is the
Linux call of its name; a failure throws an error carrying the call's
`code` (and `errno`), as Node's fs errors do.

## Methods

### close()

> **close**(`fd`): `void`

#### Parameters

##### fd

`number`

#### Returns

`void`

***

### fchmod()

> **fchmod**(`fd`, `mode`): `void`

#### Parameters

##### fd

`number`

##### mode

`number`

#### Returns

`void`

***

### fstat()

> **fstat**(`fd`): [`TreeDescriptorStats`](TreeDescriptorStats.md)

#### Parameters

##### fd

`number`

#### Returns

[`TreeDescriptorStats`](TreeDescriptorStats.md)

***

### fsync()

> **fsync**(`fd`): `void`

#### Parameters

##### fd

`number`

#### Returns

`void`

***

### ftruncate()

> **ftruncate**(`fd`, `length`): `void`

#### Parameters

##### fd

`number`

##### length

`number`

#### Returns

`void`

***

### futimes()

> **futimes**(`fd`, `atime`, `mtime`): `void`

futimens(2), in seconds.

#### Parameters

##### fd

`number`

##### atime

`number`

##### mtime

`number`

#### Returns

`void`

***

### open()

> **open**(`path`, `flags`, `mode`): `number`

open(2): `flags` are the O_* bits Node passes, `mode` the creation mode; answers the fd.

#### Parameters

##### path

`string`

##### flags

`number`

##### mode

`number`

#### Returns

`number`

***

### read()

> **read**(`fd`, `buffer`, `offset`, `length`, `position`): `number`

read(2) at the description's offset when `position` is null, pread(2) at `position` otherwise.

#### Parameters

##### fd

`number`

##### buffer

`Uint8Array`

##### offset

`number`

##### length

`number`

##### position

`number` \| `null`

#### Returns

`number`

***

### release()

> **release**(`fd`): `void`

#### Parameters

##### fd

`number`

#### Returns

`void`

***

### reserve()

> **reserve**(): `number`

A number for a handle of the engine's own (a pipe, a socket), held until `release`.

#### Returns

`number`

***

### write()

> **write**(`fd`, `buffer`, `offset`, `length`, `position`): `number`

write(2) (honouring O_APPEND) when `position` is null, pwrite(2) at `position` otherwise.

#### Parameters

##### fd

`number`

##### buffer

`Uint8Array`

##### offset

`number`

##### length

`number`

##### position

`number` \| `null`

#### Returns

`number`
