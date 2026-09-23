[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / ProcessIdentity

# Interface: ProcessIdentity

Native process identity shared by the container's worker realms.

## Properties

### argv?

> `readonly` `optional` **argv?**: readonly `string`[]

What the process was started as, where its starter said: `/proc/<pid>/cmdline`.

***

### cwd?

> `readonly` `optional` **cwd?**: `string`

The directory it was started in: `/proc/<pid>/cwd`.

***

### pid

> `readonly` **pid**: `number`

***

### ppid

> `readonly` **ppid**: `number`

***

### startedAt?

> `readonly` `optional` **startedAt?**: `number`

When it started, in milliseconds since the epoch.
