/**
 * `internalBinding('fs_dir')` OVER libuv (ADR-0018 §3, item 6): Node v24.21.0's src/node_dir.cc. A DirHandle owns
 * the uv_dir_t uv_fs_opendir made (in the process's memory); `read` is uv_fs_readdir of up to `bufferSize` entries
 * and `close` uv_fs_closedir, each synchronous or on libuv's threadpool as its request says.
 */
import { nodeProgram, type AttachedNodeProgram } from './program';
import { Room, dispatch, getReqWrap, resolve, parseEncoding, pathBytes, pathText, uvException, afterNoArgs,
  type After, type FsContext, type FSReq } from './fs_req';

export function createNodeDirBinding(context: FsContext) {
  /** DirentListToArray: name and type, one after the other, for each entry read. */
  const entries = (program: AttachedNodeProgram, dir: number, count: number, encoding: FSReq['encoding']): unknown[] => {
    const list: unknown[] = [];
    for (let i = 0; i < count; i++) {
      list.push(context.encode(program.cBytes(program.exports.tabnode_fs_dir_entry_name(dir, i)) ?? new Uint8Array(0), encoding));
      list.push(program.exports.tabnode_fs_dir_entry_type(dir, i));
    }
    return list;
  };

  /** DirHandle (node_dir.cc): an AsyncWrap over a uv_dir_t. */
  class DirHandle {
    readonly #dir: number;
    constructor(dir: number) {
      this.#dir = dir >>> 0;
      nodeProgram().exports.tabnode_fs_dir_adopt(this.#dir);
    }

    /** DirHandle::Read: null when the directory is done, else [name, type, ...]. */
    read(encoding: unknown, bufferSize: unknown, req?: unknown): unknown {
      const program = nodeProgram();
      const enc = parseEncoding(encoding);
      const size = Math.max(0, Math.trunc(Number(bufferSize)));
      const dir = this.#dir;
      // AfterDirRead: the entries read before the request is cleared, which frees their names.
      const afterDirRead: After = (_lib, wrap, done) => {
        const value = done.result === 0 ? null : entries(program, dir, done.result, wrap.encoding);
        return () => resolve(wrap, value);
      };
      return dispatch(program, new Room(), req !== undefined ? getReqWrap(req) : null, {
        syscall: 'readdir', encoding: enc, after: afterDirRead,
        call: (r, _b, a) => program.exports.tabnode_fs_readdir(r, dir, size, a),
        sync: (_r, _b, result) => result === 0 ? null : entries(program, dir, result, enc),
      });
    }

    /** DirHandle::Close. */
    close(req?: unknown): unknown {
      const program = nodeProgram();
      const dir = this.#dir;
      return dispatch(program, new Room(), req !== undefined ? getReqWrap(req) : null, {
        syscall: 'closedir', after: afterNoArgs, call: (r, _b, a) => program.exports.tabnode_fs_closedir(r, dir, a),
      });
    }
  }

  /** AfterOpenDir: a DirHandle over req->ptr. */
  const afterOpenDir: After = (program, req, done) => {
    const handle = new DirHandle(program.exports.tabnode_fs_ptr(done.request));
    return () => resolve(req, handle);
  };

  const fsDirBinding = {
    DirHandle,
    opendir(path: unknown, encoding: unknown, req?: unknown): unknown {
      const program = nodeProgram();
      const bytes = pathBytes(path);
      const room = new Room();
      const at = room.cstr(bytes);
      return dispatch(program, room, req !== undefined ? getReqWrap(req) : null, {
        syscall: 'opendir', path: pathText(bytes), encoding: parseEncoding(encoding), after: afterOpenDir,
        call: (r, b, a) => program.exports.tabnode_fs_opendir(r, b + at, a),
        sync: (r) => new DirHandle(program.exports.tabnode_fs_ptr(r)),
      });
    },
    /** OpenDirSync: its error names the syscall alone. */
    opendirSync(path: unknown): unknown {
      const program = nodeProgram();
      const room = new Room();
      const at = room.cstr(pathBytes(path));
      const { request, base } = room.open(program);
      try {
        const err = program.exports.tabnode_fs_opendir(request, base + at, 0);
        if (err < 0) throw uvException(program, err, 'opendir', null, null, null);
        return new DirHandle(program.exports.tabnode_fs_ptr(request));
      } finally {
        program.exports.tabnode_fs_free(request);
      }
    },
  };

  return { fsDirBinding, DirHandle };
}
