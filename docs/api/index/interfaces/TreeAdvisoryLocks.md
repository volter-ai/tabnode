[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeAdvisoryLocks

# Interface: TreeAdvisoryLocks

## Methods

### fcntl()

> **fcntl**(`fd`, `command`, `record`): [`TreeRecordLock`](TreeRecordLock.md)

Linux F_GETLK/F_SETLK/F_SETLKW (and OFD forms); failure throws the real errno.

#### Parameters

##### fd

`number`

##### command

`number`

##### record

[`TreeRecordLock`](TreeRecordLock.md)

#### Returns

[`TreeRecordLock`](TreeRecordLock.md)

***

### flock()

> **flock**(`fd`, `operation`): `void`

Locks the open description, released by its last close, including duplicates.

#### Parameters

##### fd

`number`

##### operation

`number`

#### Returns

`void`

***

### releasePosixOnClose()

> **releasePosixOnClose**(`fd`): `void`

NODERAWFS's logical dup close; the owner skips files with no POSIX lock.

#### Parameters

##### fd

`number`

#### Returns

`void`
