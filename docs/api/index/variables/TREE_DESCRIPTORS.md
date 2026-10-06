[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / TREE\_DESCRIPTORS

# Variable: TREE\_DESCRIPTORS

> `const` **TREE\_DESCRIPTORS**: *typeof* `TREE_DESCRIPTORS`

A tree that owns its open file descriptions.

The engine's own trees keep a descriptor table of the engine's: an fd is a
path, flags and an offset in `node-lib/binding/fs.ts`. A tree a host
supplies may instead be a client of a kernel that keeps those descriptions
itself, shared with every other process of the kernel: one offset for a
dup'd or inherited descriptor, `O_APPEND` decided where the file is,
locks, and fork and exec inheritance (ADR-0005). Such a tree offers this
capability under `TREE_DESCRIPTORS`, and the engine then asks it for every
descriptor operation on a file it opened, and for the numbers of the
engine's own handles, so the process has one numbering.

A symbol, not method names: `openSync`/`readSync` are what a Node `fs`
module looks like, and a tree that happened to carry one would be taken
for a kernel's.
