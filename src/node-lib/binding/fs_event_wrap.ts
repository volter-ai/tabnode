/**
 * `internalBinding('fs_event_wrap')` OVER libuv (ADR-0018 §3, item 6): Node v24.21.0's src/fs_event_wrap.cc. An
 * FSEvent is a HandleWrap over a uv_fs_event_t in the process's memory, so `fs.watch` is libuv's inotify watch in the
 * process's kernel, and each change is the program's `fs_event` import.
 */
import { libnode, listenHandle } from './libnode';
import { Room, codeError, parseEncoding, pathBytes, type FsContext } from './fs_req';
import { callOnClose, kOnClose } from './node_file';
import { AsyncResource } from '../internals/runtime';
import { currentOwner, ownedRun, registerHandle, releaseHandle, refHandle, unrefHandle, observeNodeHandle, forgetNodeHandle,
  type OwnedHandle } from './handles';
import type { ProcessToken } from '../../process-tokens';

const UV_FS_EVENT_RECURSIVE = 4;
const UV_RENAME = 1;
const UV_CHANGE = 2;
const UV_EINVAL = -22;

export function createFsEventWrapBinding(context: FsContext) {
  /** FSEventWrap: made uninitialized (MarkAsUninitialized); `start` initializes and starts its handle. */
  class FSEvent implements OwnedHandle {
    onchange: unknown = null;
    #handle = 0;
    #state: 'initialized' | 'closing' | 'closed' = 'closed';
    #encoding: ReturnType<typeof parseEncoding> = 'utf8';
    readonly #resource = new AsyncResource('FSEVENTWRAP');
    readonly #owner: ProcessToken | null = currentOwner();
    #held = false;

    /** GetInitialized: the handle is not closing. */
    get initialized(): boolean { return this.#state === 'initialized'; }

    /** FSEventWrap::Start(filename, persistent, recursive, encoding): 0, or libuv's error. */
    start(path: unknown, persistent: unknown, recursive: unknown, encoding: unknown): number {
      if (this.#state === 'initialized') throw codeError('ERR_INVALID_STATE', 'FSEvent: already started');
      const lib = libnode();
      const flags = recursive === true ? UV_FS_EVENT_RECURSIVE : 0;
      this.#encoding = parseEncoding(encoding);
      const handle = lib.exports.tabnode_fs_event_new() >>> 0;
      if (handle === 0) return -12;
      let err = lib.exports.tabnode_fs_event_init(handle);
      if (err !== 0) return err;
      this.#handle = handle;
      this.#listen();
      const room = new Room();
      const at = room.cstr(pathBytes(path));
      const { request, base } = room.open(lib);
      try { err = lib.exports.tabnode_fs_event_start(handle, base + at, flags); }
      finally { lib.exports.tabnode_fs_free(request); }
      // MarkAsInitialized
      this.#state = 'initialized';
      observeNodeHandle(this, () => this.hasRef());
      if (err !== 0) {
        this.close();
        return err;
      }
      this.#hold();
      // Check for persistent argument
      if (persistent !== true) this.unref();
      return err;
    }

    // HandleWrap's close, ref, unref and hasRef (src/handle_wrap.cc).
    close(callback?: unknown): void {
      if (this.#state !== 'initialized') return;
      libnode().exports.tabnode_handle_close(this.#handle);
      this.#state = 'closing';
      if (typeof callback === 'function') (this as Record<symbol, unknown>)[kOnClose] = callback;
    }
    ref(): void {
      if (this.#state === 'closed' || this.#handle === 0) return;
      libnode().exports.tabnode_handle_ref(this.#handle, 1);
      if (this.#held) refHandle(this);
    }
    unref(): void {
      if (this.#state === 'closed' || this.#handle === 0) return;
      libnode().exports.tabnode_handle_ref(this.#handle, 0);
      if (this.#held) unrefHandle(this);
    }
    hasRef(): boolean {
      return this.#state !== 'closed' && this.#handle !== 0 && libnode().exports.tabnode_handle_has_ref(this.#handle) !== 0;
    }
    getAsyncId(): number { return this.#resource.asyncId(); }

    #listen(): void {
      const lib = libnode();
      listenHandle(this.#handle, {
        // FSEventWrap::OnEvent: an error's event is empty, else rename where libuv says it, else change.
        fsEvent: (filename, events, status) => {
          const event = status ? '' : events & UV_RENAME ? 'rename' : events & UV_CHANGE ? 'change' : '';
          const argv: unknown[] = [status, event, null];
          const name = lib.cBytes(filename);
          if (name !== null) {
            try { argv[2] = context.encode(name, this.#encoding); }
            catch { argv[0] = UV_EINVAL; argv[2] = context.encode(name, 'buffer'); }
          }
          const fn = this.onchange;
          if (typeof fn !== 'function') return;
          ownedRun(this.#owner, () => this.#resource.runInAsyncScope(fn as (...values: never[]) => unknown, this, ...(argv as never[])), true, 'fs', fn);
        },
        closed: () => {
          this.#state = 'closed';
          if (this.#held) { this.#held = false; releaseHandle(this); }
          forgetNodeHandle(this);
          callOnClose(this, this.#owner, this.#resource);
        },
      });
    }

    /** The run's own count holds a started watch while it is referenced (ADR-0018 item 2). */
    #hold(): void {
      this.#held = true;
      ownedRun(this.#owner, () => registerHandle(this));
    }
  }

  return { fsEventWrapBinding: { FSEvent }, FSEvent };
}
