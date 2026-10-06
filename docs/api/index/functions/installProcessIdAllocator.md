[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / installProcessIdAllocator

# Function: installProcessIdAllocator()

> **installProcessIdAllocator**(`allocate`): `void`

Trusted container owner only: the number every process of this container
is given from now on, from a kernel's own pid counter, so a guest's
`process.pid`, its child's `process.ppid` and the kernel's `/proc` name the
same process. Installed when the kernel first starts a `node`; a number the
engine handed out before stays its holder's.

## Parameters

### allocate

() => `number`

## Returns

`void`
