[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / FSNode

# Interface: FSNode

## Properties

### atime?

> `optional` **atime?**: `number`

When the file was last read. Node reports it apart from the write time
and `utimes` sets the two separately; this filesystem reported the write
time in its place, so a program that set an access time and read it back
got the other one (Node's own test/wasi `stat` fixture asserts them
apart). Absent until something sets it, which is the write time.

***

### children?

> `optional` **children?**: `Map`\<`string`, `FSNode`\>

***

### content?

> `optional` **content?**: `Uint8Array`\<`ArrayBufferLike`\>

***

### mode?

> `optional` **mode?**: `number`

***

### mount?

> `optional` **mount?**: [`MountedTree`](MountedTree.md)

A tree mounted here: the paths below this node are the tree's, answered
when they are read, and never this filesystem's to write. Linux's
`/proc` is one.

***

### mtime

> **mtime**: `number`

***

### target?

> `optional` **target?**: `string`

Where a symlink points, exactly as it was written.

***

### type

> **type**: `"file"` \| `"directory"` \| `"symlink"`
