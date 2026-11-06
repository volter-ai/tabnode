/**
 * A child's stdio in its parent's kernel table, as libuv's `uv__process_init_stdio` makes it (ADR-0010 §1): the one
 * preparation `process_wrap`'s `Process.spawn` and `spawn_sync` both use, before the child's fork. Read in Node
 * v24.21.0's `deps/uv/src/unix/process.c`:
 *
 * - a pipe is `uv_socketpair(SOCK_STREAM, 0)`, close-on-exec, each end's `SO_RCVBUF` and `SO_SNDBUF` 64 KiB (a refusal
 *   ignored, as libuv ignores it), the parent's end non-blocking (`uv__process_open_stream`), the child's blocking;
 * - an inherited number is the parent's descriptor (a number the parent's run was started with as a kernel stream is
 *   that stream's), and whether the parent holds it is the kernel's `fcntl(F_GETFL)`;
 * - a stream is its descriptor (`uv__stream_fd`), where it is a kernel one;
 * - an ignored fd 0 to 2 is /dev/null, read-only for 0 and read-write for 1 and 2 (`uv__process_child_init`), opened
 *   through the tree, which makes every file close-on-exec;
 * - once the child is forked its fds 0 to 2 and each pipe's child end are blocking (`uv__nonblock_fcntl(fd, 0)`), and
 *   the parent closes its copies of what was made for the child.
 */
import { handleForFd } from './fds';
import { KernelStreamWrap, kHandleFd } from './kernel_stream';
import { intOption, linux, type TreeSockets } from '../../host-sockets';
import type { TreeDescriptors } from '../../tree-descriptors';

/** One of the child's fds, as the preparation reads Node's stdio entry for it. */
export type ChildStdioEntry =
  | { readonly type: 'pipe' }
  | { readonly type: 'inherit'; readonly fd: number }
  | { readonly type: 'stream'; readonly handle: unknown }
  | { readonly type: 'ignore' }
  | { readonly type: 'none' };

/** What the preparation made, which it owns until a caller takes a pipe's ends or the child is handed over. */
export interface PreparedChildStdio {
  /** The child's table: each `fd` the parent's descriptor `from`. */
  readonly placed: readonly { fd: number; from: number }[];
  /** A pipe's two ends at the child's fd `index`, whose owner the caller becomes. */
  take(index: number): { parent: number; child: number } | undefined;
  /** The parent's end of a pipe at the child's fd `index`, still the preparation's. */
  parentEnd(index: number): number | undefined;
  /** The child is forked: its fds 0 to 2 and each pipe's child end are made blocking, on the parent's numbers for them. */
  makeBlocking(): void;
  /** The parent's copies of what was made for the child and not taken (child ends, /dev/null) are closed. */
  closeMade(): void;
  /** Everything not taken is closed. */
  closeAll(): void;
}

/** uv__process_init_stdio's buffer size for each end of a child's socketpair. */
const PIPE_BUFFER_BYTES = 64 * 1024;
/** The `open(2)` modes `uv__process_child_init` opens /dev/null with. */
const O_RDONLY = 0, O_RDWR = 2;

/**
 * The child's stdio made for `entries` (the child's fd is the index), in the table `sockets` and `files` call. A
 * negative errno where one cannot be made (the kernel's `EBADF` for a number the parent does not hold), everything
 * made closed.
 */
export function prepareChildStdio(entries: readonly ChildStdioEntry[], sockets: TreeSockets, files: TreeDescriptors | undefined): PreparedChildStdio | number {
  const placed: { fd: number; from: number }[] = [];
  const pipes = new Map<number, { parent: number; child: number }>();
  const childEnds = new Set<number>();
  const nullFiles: number[] = [];
  const closeMade = (): void => {
    for (const [index, ends] of pipes) { if (ends.child >= 0) sockets.close(ends.child); pipes.set(index, { parent: ends.parent, child: -1 }); }
    for (const fd of nullFiles.splice(0)) { try { files!.close(fd); } catch { /* gone already */ } }
  };
  const closeAll = (): void => {
    closeMade();
    for (const ends of pipes.values()) if (ends.parent >= 0) sockets.close(ends.parent);
    pipes.clear();
  };
  const prepared: PreparedChildStdio = {
    placed,
    take: index => {
      const ends = pipes.get(index);
      pipes.delete(index);
      return ends && ends.child >= 0 ? ends : undefined;
    },
    parentEnd: index => pipes.get(index)?.parent,
    makeBlocking: () => {
      for (const { fd, from } of placed) {
        if (fd > 2 && !childEnds.has(from)) continue;
        const flags = sockets.fcntl(from, linux.F_GETFL, 0);
        if (flags >= 0 && (flags & linux.O_NONBLOCK) !== 0) sockets.fcntl(from, linux.F_SETFL, flags & ~linux.O_NONBLOCK);
      }
    },
    closeMade,
    closeAll,
  };
  const fail = (errno: number): number => { closeAll(); return errno; };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type === 'pipe') {
      const pair = new Int32Array(2);
      const made = sockets.socketpair(linux.AF_UNIX, linux.SOCK_STREAM | linux.SOCK_CLOEXEC, 0, pair);
      if (made < 0) return fail(made);
      const [parent, child] = [pair[0]!, pair[1]!];
      for (const fd of [parent, child]) {
        sockets.setsockopt(fd, linux.SOL_SOCKET, linux.SO_RCVBUF, intOption(PIPE_BUFFER_BYTES));
        sockets.setsockopt(fd, linux.SOL_SOCKET, linux.SO_SNDBUF, intOption(PIPE_BUFFER_BYTES));
      }
      pipes.set(index, { parent, child });
      childEnds.add(child);
      const flags = sockets.fcntl(parent, linux.F_GETFL, 0);
      if (flags < 0) return fail(flags);
      const set = sockets.fcntl(parent, linux.F_SETFL, flags | linux.O_NONBLOCK);
      if (set < 0) return fail(set);
      placed.push({ fd: index, from: child });
    } else if (entry.type === 'inherit') {
      const held = handleForFd(entry.fd);
      const from = held instanceof KernelStreamWrap && held.kernelBacked ? held[kHandleFd] : entry.fd;
      const flags = sockets.fcntl(from, linux.F_GETFL, 0);
      if (flags < 0) return fail(flags);
      placed.push({ fd: index, from });
    } else if (entry.type === 'stream') {
      const handle = entry.handle;
      if (handle instanceof KernelStreamWrap && handle.kernelBacked && handle[kHandleFd] >= 0) placed.push({ fd: index, from: handle[kHandleFd] });
    } else if (entry.type === 'ignore' && index <= 2 && files) {
      let fd: number;
      try { fd = files.open('/dev/null', index === 0 ? O_RDONLY : O_RDWR, 0); }
      catch (cause) {
        const errno = (cause as { errno?: unknown } | null)?.errno;
        closeAll();
        if (typeof errno !== 'number' || errno === 0) throw cause;
        return -Math.abs(errno);
      }
      nullFiles.push(fd);
      placed.push({ fd: index, from: fd });
    }
  }
  return prepared;
}
