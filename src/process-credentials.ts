/** Process identity supplied by the host; numeric uid/gid and supplementary groups. */
export interface ProcessCredentials {
  uid: number;
  gid: number;
  groups: readonly number[];
}

/** Numeric Linux ids only: credentials are configuration, never environment or guest getter values. */
export function copyProcessCredentials(value?: ProcessCredentials): Readonly<ProcessCredentials> {
  if (value === undefined) return Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]) });
  if (value === null || typeof value !== 'object' || !Array.isArray(value.groups)) throw new TypeError('credentials must contain numeric uid, gid and groups');
  const id = (value: number, name: string): number => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`credentials.${name} must be an unsigned 32-bit integer`);
    return value;
  };
  return Object.freeze({ uid: id(value.uid, 'uid'), gid: id(value.gid, 'gid'), groups: Object.freeze(Array.from(value.groups, group => id(group, 'groups'))) });
}

const credentialsByProcess = new WeakMap<object, Readonly<ProcessCredentials>>();

/** Called only when a host creates its process; there is no guest credential mutation API. */
export function recordProcessCredentials(process: object, credentials: Readonly<ProcessCredentials>): void {
  credentialsByProcess.set(process, credentials);
}

/** A fresh record for a child or realm; guest changes to process getters cannot change inheritance. */
export function processCredentialsOf(process: object): Readonly<ProcessCredentials> {
  return copyProcessCredentials(credentialsByProcess.get(process));
}

/** libuv's child setup: clear root's supplementary groups, then set gid and uid before exec. */
export function spawnedProcessCredentials(parent: Readonly<ProcessCredentials>, uid?: number, gid?: number): Readonly<ProcessCredentials> {
  if (uid == null && gid == null) return copyProcessCredentials(parent);
  const credentials = copyProcessCredentials({ uid: uid ?? parent.uid, gid: gid ?? parent.gid, groups: parent.uid === 0 ? [] : parent.groups });
  if (parent.uid !== 0 && (credentials.uid !== parent.uid || credentials.gid !== parent.gid)) {
    throw Object.assign(new Error('EPERM: child uid/gid differ from the non-root parent'), { code: 'EPERM' });
  }
  return credentials;
}
