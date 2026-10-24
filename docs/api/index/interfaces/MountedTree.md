[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / MountedTree

# Interface: MountedTree

A read-only tree another party answers, mounted at a directory: `node`
returns what is at a path relative to the mount point (`/` is the mount
point itself), computed when it is asked, or undefined where nothing is.
A directory's `children` names what a listing shows; a link's `target` is
followed as any link is.

## Methods

### node()

> **node**(`path`): [`FSNode`](FSNode.md) \| `undefined`

#### Parameters

##### path

`string`

#### Returns

[`FSNode`](FSNode.md) \| `undefined`
