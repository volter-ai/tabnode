[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TreeDescriptorStats

# Interface: TreeDescriptorStats

What the stat of an open description answers, in the shape a tree's `statSync` answers.

## Properties

### atime?

> `optional` **atime?**: `Date`

***

### atimeMs?

> `optional` **atimeMs?**: `number`

***

### birthtime?

> `optional` **birthtime?**: `Date`

***

### birthtimeMs?

> `optional` **birthtimeMs?**: `number`

***

### blksize?

> `optional` **blksize?**: `number`

***

### blocks?

> `optional` **blocks?**: `number`

***

### ctime?

> `optional` **ctime?**: `Date`

***

### ctimeMs?

> `optional` **ctimeMs?**: `number`

***

### dev?

> `optional` **dev?**: `number`

***

### gid?

> `optional` **gid?**: `number`

***

### ino?

> `optional` **ino?**: `number`

***

### mode

> **mode**: `number`

***

### mtime?

> `optional` **mtime?**: `Date`

***

### mtimeMs?

> `optional` **mtimeMs?**: `number`

***

### nlink?

> `optional` **nlink?**: `number`

***

### rdev?

> `optional` **rdev?**: `number`

***

### size

> **size**: `number`

***

### uid?

> `optional` **uid?**: `number`

## Methods

### isBlockDevice()?

> `optional` **isBlockDevice**(): `boolean`

#### Returns

`boolean`

***

### isCharacterDevice()?

> `optional` **isCharacterDevice**(): `boolean`

The other kinds of file, where the tree has them; a mode's type bits answer first.

#### Returns

`boolean`

***

### isDirectory()

> **isDirectory**(): `boolean`

#### Returns

`boolean`

***

### isFIFO()?

> `optional` **isFIFO**(): `boolean`

#### Returns

`boolean`

***

### isFile()

> **isFile**(): `boolean`

#### Returns

`boolean`

***

### isSocket()?

> `optional` **isSocket**(): `boolean`

#### Returns

`boolean`

***

### isSymbolicLink()

> **isSymbolicLink**(): `boolean`

#### Returns

`boolean`
