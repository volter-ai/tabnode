/**
 * `internalBinding('fs_event_wrap')` OVER libuv (ADR-0018 §3, item 6): Node v24.21.0's src/fs_event_wrap.cc. An
 * FSEvent is a HandleWrap over a uv_fs_event_t in the process's memory, so `fs.watch` is libuv's inotify watch in the
 * process's kernel, and each change is the program's `fs_event` import.
 */
import { libnode, type HandleCallbacks } from './libnode';
import { HandleWrap } from './handle_wrap';
import { Room, codeError, parseEncoding, pathBytes, type FsContext } from './fs_req';
import { uvConstant } from './uv';
import { AsyncResource } from '../internals/runtime';
import { currentOwner, ownedRun, type OwnedHandle } from './handles';
import type { ProcessToken } from '../../process-tokens';


export function createFsEventWrapBinding(context: FsContext) {
  /** FSEventWrap: its uv_fs_event_t made with it, uninitialized (MarkAsUninitialized) until `start`. */
  class FSEvent implements OwnedHandle, HandleCallbacks {
    onchange: unknown = null;
    readonly #handle: HandleWrap;
    #encoding: ReturnType<typeof parseEncoding> = 'utf8';
    readonly #resource = new AsyncResource('FSEVENTWRAP');
    readonly #owner: ProcessToken | null = currentOwner();

    constructor() {
      this.#handle = new HandleWrap(this, this, libnode().exports.tabnode_fs_event_new(), false);
    }

    /** GetInitialized: the handle is not closing (IsHandleClosing: closing or closed). */
    get initialized(): boolean { return this.#handle.alive && !this.#handle.closing; }

    /** FSEventWrap::Start(filename, persistent, recursive, encoding) (fs_event_wrap.cc:139-181): 0, or libuv's error. */
    start(path: unknown, persistent: unknown, recursive: unknown, encoding: unknown): number {
      if (this.initialized) throw codeError('ERR_INVALID_STATE', 'FSEvent: already started');
      const lib = libnode();
      const handle = this.#handle.wrap;
      this.#encoding = parseEncoding(encoding);
      let err = lib.exports.tabnode_fs_event_init(handle);
      if (err !== 0) return err;
      const room = new Room();
      const at = room.cstr(pathBytes(path));
      const { request, base } = room.open(lib);
      try { err = lib.exports.tabnode_fs_event_start(handle, base + at, recursive === true ? 1 : 0); }
      finally { lib.exports.tabnode_fs_free(request); }
      this.#handle.markAsInitialized();
      if (err !== 0) {
        this.#handle.close(undefined);
        return err;
      }
      // Check for persistent argument
      if (persistent !== true) lib.exports.tabnode_handle_unref(handle);
      return err;
    }

    // HandleWrap's close, ref, unref and hasRef (src/handle_wrap.cc).
    close(callback?: unknown): void { this.#handle.close(callback); }
    ref(): void { this.#handle.ref(); }
    unref(): void { this.#handle.unref(); }
    hasRef(): boolean { return this.#handle.hasRef(); }
    getAsyncId(): number { return this.#resource.asyncId(); }

    /** FSEventWrap::OnEvent: the status, the event's name the C chose (fs_event.c), and the filename encoded. */
    onUvFsEvent(filename: number, event: string, status: number): void {
      const argv: unknown[] = [status, event, null];
      const name = libnode().cBytes(filename);
      if (name !== null) {
        try { argv[2] = context.encode(name, this.#encoding); }
        catch { argv[0] = uvConstant('UV_EINVAL'); argv[2] = context.encode(name, 'buffer'); }
      }
      const fn = this.onchange;
      if (typeof fn !== 'function') return;
      ownedRun(this.#owner, () => this.#resource.runInAsyncScope(fn as (...values: never[]) => unknown, this, ...(argv as never[])), true, 'fs', fn);
    }
  }

  return { fsEventWrapBinding: { FSEvent }, FSEvent };
}
