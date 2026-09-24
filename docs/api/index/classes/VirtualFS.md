[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / VirtualFS

# Class: VirtualFS

## Constructors

### Constructor

> **new VirtualFS**(): `VirtualFS`

#### Returns

`VirtualFS`

## Methods

### \_\_substrateLinkTarget()

> **\_\_substrateLinkTarget**(`linkPath`, `target`): `string`

A link's target as an absolute path: absolute as written, or relative to the link's directory.

#### Parameters

##### linkPath

`string`

##### target

`string`

#### Returns

`string`

***

### \_\_substrateNode()

> **\_\_substrateNode**(`path`, `follow`, `depth`): [`FSNode`](../interfaces/FSNode.md) \| `undefined`

The node at a path, following every link on the way and, when `follow`, the last one too.

#### Parameters

##### path

`string`

##### follow

`boolean`

##### depth

`number`

#### Returns

[`FSNode`](../interfaces/FSNode.md) \| `undefined`

***

### access()

> **access**(`path`, `modeOrCallback?`, `callback?`): `void`

Async access

#### Parameters

##### path

`string`

##### modeOrCallback?

`number` \| ((`err`) => `void`)

##### callback?

(`err`) => `void`

#### Returns

`void`

***

### accessSync()

> **accessSync**(`path`, `mode?`): `void`

Access check - in our VFS, always succeeds if file exists

#### Parameters

##### path

`string`

##### mode?

`number`

#### Returns

`void`

***

### appendFileSync()

> **appendFileSync**(`path`, `data`): `void`

Adds bytes at a file's end, creating it. A file grown a piece at a time
(a write stream's chunks) is kept in a buffer with room to grow, so an
append copies only what it adds: writing the whole file again for each
1 KB chunk of a 50 MB file copied about a terabyte. A tree that keeps its
files elsewhere (its own writeFileSync) is appended to through its own
read and write unless it answers appends itself.

#### Parameters

##### path

`string`

##### data

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

#### Returns

`void`

***

### chmodSync()

> **chmodSync**(`path`, `mode`): `void`

Get stats for path

#### Parameters

##### path

`string`

##### mode

`number`

#### Returns

`void`

***

### copyFileSync()

> **copyFileSync**(`src`, `dest`): `void`

Copy file

#### Parameters

##### src

`string`

##### dest

`string`

#### Returns

`void`

***

### createReadStream()

> **createReadStream**(`path`, `options?`): `FsReadStream`

Create read stream - simplified implementation

#### Parameters

##### path

`string`

##### options?

`string` \| `ReadStreamOptions`

#### Returns

`FsReadStream`

***

### createWriteStream()

> **createWriteStream**(`path`): `object`

Create write stream - simplified implementation

#### Parameters

##### path

`string`

#### Returns

`object`

##### end

> **end**: (`data?`) => `void`

###### Parameters

###### data?

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

###### Returns

`void`

##### on

> **on**: (`event`, `cb`) => `void`

###### Parameters

###### event

`string`

###### cb

(...`args`) => `void`

###### Returns

`void`

##### write

> **write**: (`data`) => `boolean`

###### Parameters

###### data

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

###### Returns

`boolean`

***

### existsSync()

> **existsSync**(`path`): `boolean`

Check if path exists

#### Parameters

##### path

`string`

#### Returns

`boolean`

***

### getNode()

> **getNode**(`path`): [`FSNode`](../interfaces/FSNode.md) \| `undefined`

Get node at path, returns undefined if not found

#### Parameters

##### path

`string`

#### Returns

[`FSNode`](../interfaces/FSNode.md) \| `undefined`

***

### lstat()

> **lstat**(`path`, `callback`): `void`

Async lstat

#### Parameters

##### path

`string`

##### callback

(`err`, `stats?`) => `void`

#### Returns

`void`

***

### lstatSync()

> **lstatSync**(`path`): [`Stats`](../interfaces/Stats.md)

lstatSync - same as statSync for our virtual FS (no symlinks)

#### Parameters

##### path

`string`

#### Returns

[`Stats`](../interfaces/Stats.md)

***

### mkdirSync()

> **mkdirSync**(`path`, `options?`): `void`

Create directory, optionally with recursive parent creation

#### Parameters

##### path

`string`

##### options?

###### recursive?

`boolean`

#### Returns

`void`

***

### mount()

> **mount**(`path`, `tree`): () => `void`

Mount a read-only tree at a directory, as Linux mounts `/proc`: reads
below it are the tree's answers, writes fail with `EROFS`, and a snapshot
leaves it out. Answers the unmount.

#### Parameters

##### path

`string`

##### tree

[`MountedTree`](../interfaces/MountedTree.md)

#### Returns

() => `void`

***

### off()

#### Call Signature

> **off**(`event`, `listener`): `this`

Remove event listener

##### Parameters

###### event

`"change"`

###### listener

`VFSChangeListener`

##### Returns

`this`

#### Call Signature

> **off**(`event`, `listener`): `this`

Remove event listener

##### Parameters

###### event

`"delete"`

###### listener

`VFSDeleteListener`

##### Returns

`this`

***

### on()

#### Call Signature

> **on**(`event`, `listener`): `this`

Add event listener (for change notifications to workers)

##### Parameters

###### event

`"change"`

###### listener

`VFSChangeListener`

##### Returns

`this`

#### Call Signature

> **on**(`event`, `listener`): `this`

Add event listener (for change notifications to workers)

##### Parameters

###### event

`"delete"`

###### listener

`VFSDeleteListener`

##### Returns

`this`

***

### readdir()

> **readdir**(`path`, `optionsOrCallback?`, `callback?`): `void`

Async readdir

#### Parameters

##### path

`string`

##### optionsOrCallback?

\{ `withFileTypes?`: `boolean`; \} \| ((`err`, `files?`) => `void`)

##### callback?

(`err`, `files?`) => `void`

#### Returns

`void`

***

### readdirSync()

> **readdirSync**(`path`): `string`[]

Read directory contents

#### Parameters

##### path

`string`

#### Returns

`string`[]

***

### readFile()

> **readFile**(`path`, `optionsOrCallback?`, `callback?`): `void` \| `Promise`\<`string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Read file with optional options parameter

#### Parameters

##### path

`string`

##### optionsOrCallback?

`string` \| \{ `encoding?`: `string`; \} \| ((`err`, `data?`) => `void`)

##### callback?

(`err`, `data?`) => `void`

#### Returns

`void` \| `Promise`\<`string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

***

### readFileSync()

#### Call Signature

> **readFileSync**(`path`): `Uint8Array`

Read file contents as Uint8Array

##### Parameters

###### path

`string`

##### Returns

`Uint8Array`

#### Call Signature

> **readFileSync**(`path`, `encoding`): `string`

Read file contents as Uint8Array

##### Parameters

###### path

`string`

###### encoding

`"utf8"` \| `"utf-8"`

##### Returns

`string`

***

### readlinkSync()

> **readlinkSync**(`path`): `string`

#### Parameters

##### path

`string`

#### Returns

`string`

***

### realpath()

> **realpath**(`path`, `callback`): `void`

Async realpath

#### Parameters

##### path

`string`

##### callback

(`err`, `resolvedPath?`) => `void`

#### Returns

`void`

***

### realpathSync()

> **realpathSync**(`path`): `string`

Sync realpath - in our VFS, just normalize the path

#### Parameters

##### path

`string`

#### Returns

`string`

***

### renameSync()

> **renameSync**(`oldPath`, `newPath`): `void`

Rename/move file or directory

#### Parameters

##### oldPath

`string`

##### newPath

`string`

#### Returns

`void`

***

### rmdirSync()

> **rmdirSync**(`path`): `void`

Remove directory (must be empty)

#### Parameters

##### path

`string`

#### Returns

`void`

***

### stat()

> **stat**(`path`, `callback`): `void`

Async stat

#### Parameters

##### path

`string`

##### callback

(`err`, `stats?`) => `void`

#### Returns

`void`

***

### statSync()

> **statSync**(`path`): [`Stats`](../interfaces/Stats.md)

#### Parameters

##### path

`string`

#### Returns

[`Stats`](../interfaces/Stats.md)

***

### symlinkSync()

> **symlinkSync**(`target`, `path`): `void`

#### Parameters

##### target

`string`

##### path

`string`

#### Returns

`void`

***

### toSnapshot()

> **toSnapshot**(): [`VFSSnapshot`](../interfaces/VFSSnapshot.md)

Serialize the entire file tree to a snapshot (for worker transfer)

#### Returns

[`VFSSnapshot`](../interfaces/VFSSnapshot.md)

***

### unlinkSync()

> **unlinkSync**(`path`): `void`

Remove file

#### Parameters

##### path

`string`

#### Returns

`void`

***

### utimesSync()

> **utimesSync**(`path`, `atime`, `mtime`): `void`

#### Parameters

##### path

`string`

##### atime

`number` \| `Date`

##### mtime

`number` \| `Date`

#### Returns

`void`

***

### watch()

> **watch**(`filename`, `optionsOrListener?`, `listener?`): [`FSWatcher`](../interfaces/FSWatcher.md)

Watch for file changes

#### Parameters

##### filename

`string`

##### optionsOrListener?

\{ `encoding?`: `string`; `persistent?`: `boolean`; `recursive?`: `boolean`; \} \| [`WatchListener`](../type-aliases/WatchListener.md)

##### listener?

[`WatchListener`](../type-aliases/WatchListener.md)

#### Returns

[`FSWatcher`](../interfaces/FSWatcher.md)

***

### writeFileSync()

> **writeFileSync**(`path`, `data`): `void`

Write data to file, creating parent directories as needed

#### Parameters

##### path

`string`

##### data

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

#### Returns

`void`

***

### fromSnapshot()

> `static` **fromSnapshot**(`snapshot`): `VirtualFS`

Create a VirtualFS from a snapshot

#### Parameters

##### snapshot

[`VFSSnapshot`](../interfaces/VFSSnapshot.md)

#### Returns

`VirtualFS`
