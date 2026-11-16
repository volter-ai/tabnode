/**
 * `internalBinding('credentials')` where the realm's process is `node` (ADR-0018 §7): Node v24.21.0's
 * src/node_credentials.cc split where V8 stands, its libc calls the program's (native/node/credentials.c). Node's own
 * `internal/bootstrap/node.js` and `switches/does_own_process_state.js` wrap it. `safeGetenv` and `getTempDir` read
 * the Environment's store, RealEnvStore over libc's environ (env_var.ts), and nothing where SafeGetenv refuses.
 */
import { address, libnode, withCString } from './libnode';
import { constantsBinding } from '../../shims/constants';
import type { EnvStore } from './env_var';

/** ErrnoException (src/api/exceptions.cc), as `env->ThrowErrnoException(errno, syscall)` throws it. */
export function errnoException(errno: number, syscall: string): Error {
  const names = constantsBinding().os.errno as Record<string, number>;
  const code = Object.keys(names).find((name) => names[name] === errno) ?? '';
  const program = libnode();
  const message = program.cString(program.exports.tabnode_strerror(errno)) ?? '';
  return Object.assign(new Error(`${code}: ${message}, ${syscall}`), { errno, code, syscall });
}

/** A credential as Node's uid_by_name and gid_by_name take it: a Uint32, else its string form as a name. */
function credentialOf(value: unknown): { name: string | null; id: number } {
  if (typeof value === 'number' && value >>> 0 === value) return { name: null, id: value };
  return { name: `${value}`, id: 0 };
}

export function createCredentialsBinding(env: EnvStore): Record<string, unknown> {
  const program = () => libnode().exports;
  const lastErrno = (): number => program().tabnode_errno();
  const setter = (call: 'tabnode_setuid' | 'tabnode_seteuid' | 'tabnode_setgid' | 'tabnode_setegid', syscall: string) =>
    (value: unknown): number => {
      const { name, id } = credentialOf(value);
      const answer = withCString(name, (at) => program()[call](at, id));
      if (answer === -1) throw errnoException(lastErrno(), syscall);
      return answer;
    };
  /** SafeGetenv (74-104): the store's value, none where the process may not read its environment. */
  const safeGetenv = (key: string): string | undefined => (program().tabnode_safe_getenv_refused() ? undefined : env.get(key));
  return {
    safeGetenv(key: unknown): string | undefined {
      if (typeof key !== 'string') throw new TypeError('safeGetenv: a string');
      return safeGetenv(key);
    },
    // GetTempDir (119-143): TMPDIR, TMP or TEMP, the first that is not empty, without a trailing slash.
    getTempDir(): string | undefined {
      let dir = '';
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
        dir = safeGetenv(key) ?? dir;
        if (dir !== '') break;
      }
      if (dir === '') return undefined;
      return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
    },
    implementsPosixCredentials: true,
    getuid: (): number => program().tabnode_getuid() >>> 0,
    geteuid: (): number => program().tabnode_geteuid() >>> 0,
    getgid: (): number => program().tabnode_getgid() >>> 0,
    getegid: (): number => program().tabnode_getegid() >>> 0,
    getgroups(): number[] {
      const exports = program();
      const count = exports.tabnode_getgroups(0, 0);
      if (count === -1) throw errnoException(lastErrno(), 'getgroups');
      const room = address(exports.tabnode_malloc(Math.max(count, 1) * 4));
      try {
        const found = exports.tabnode_getgroups(count, room);
        if (found === -1) throw errnoException(lastErrno(), 'getgroups');
        const bytes = libnode().read(room, found * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, found * 4);
        const groups: number[] = [];
        for (let index = 0; index < found; index++) groups.push(view.getUint32(index * 4, true));
        const egid = exports.tabnode_getegid() >>> 0;
        if (!groups.includes(egid)) groups.push(egid);
        return groups;
      } finally { exports.tabnode_free(room); }
    },
    setuid: setter('tabnode_setuid', 'setuid'),
    seteuid: setter('tabnode_seteuid', 'seteuid'),
    setgid: setter('tabnode_setgid', 'setgid'),
    setegid: setter('tabnode_setegid', 'setegid'),
    setgroups(list: unknown): number {
      if (!Array.isArray(list)) throw new TypeError('setgroups: an array');
      const exports = program();
      const credentials = list.map(credentialOf);
      const encoder = new TextEncoder();
      const names = address(exports.tabnode_malloc(Math.max(credentials.length, 1) * 4));
      const ids = address(exports.tabnode_malloc(Math.max(credentials.length, 1) * 4));
      const strings: number[] = [];
      try {
        const nameTable = new DataView(new ArrayBuffer(credentials.length * 4));
        const idTable = new DataView(new ArrayBuffer(credentials.length * 4));
        credentials.forEach(({ name, id }, index) => {
          let at = 0;
          if (name !== null) {
            const bytes = encoder.encode(name);
            at = address(exports.tabnode_malloc(bytes.byteLength + 1));
            const room = new Uint8Array(bytes.byteLength + 1);
            room.set(bytes);
            libnode().write(at, room);
            strings.push(at);
          }
          nameTable.setUint32(index * 4, at, true);
          idTable.setUint32(index * 4, id, true);
        });
        if (credentials.length > 0) {
          libnode().write(names, new Uint8Array(nameTable.buffer));
          libnode().write(ids, new Uint8Array(idTable.buffer));
        }
        const answer = exports.tabnode_setgroups(credentials.length, names, ids);
        if (answer === -1) throw errnoException(lastErrno(), 'setgroups');
        return answer;
      } finally {
        for (const at of strings) exports.tabnode_free(at);
        exports.tabnode_free(names);
        exports.tabnode_free(ids);
      }
    },
    initgroups(user: unknown, extraGroup: unknown): number {
      const who = credentialOf(user), group = credentialOf(extraGroup);
      const answer = withCString(who.name, (userAt) => withCString(group.name, (groupAt) =>
        program().tabnode_initgroups(userAt, who.id, groupAt, group.id)));
      if (answer === -1) throw errnoException(lastErrno(), 'initgroups');
      return answer;
    },
  };
}
