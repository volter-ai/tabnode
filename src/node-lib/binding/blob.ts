/**
 * `internalBinding('blob')`: the one call Node's `fs.openAsBlob` makes.
 *
 * Node's `internal/blob` reads the file through this binding and answers a
 * Blob of the realm. The engine has no C++ blob handle, so the bytes come
 * off the same tree the fs binding reads -- the run's filesystem, hung off
 * the guest process under the same key -- and the Blob is the realm's own.
 * This file does not import the fs binding: both are reached from the
 * loader, and a cycle there left the open unanswered.
 */
import type { VirtualFS } from '../../virtual-fs';

const kRunFilesystem = Symbol.for('tabnode.run.vfs');

function tree(): VirtualFS {
  const realm = globalThis as unknown as { process?: Record<symbol, unknown> };
  const found = realm.process?.[kRunFilesystem] as VirtualFS | undefined;
  if (!found) {
    throw Object.assign(new Error('fs: this realm has no filesystem; the engine gives a run one when it starts'), { code: 'ENOSYS' });
  }
  return found;
}

/**
 * Node's `createBlobFromFilePath(path, { type })`: the bytes of that path
 * as a realm `Blob`. `fs.openAsBlob` is a promise of this value.
 */
export function createBlobFromFilePath(path: string, options?: { type?: string }): Blob {
  const bytes = tree().readFileSync(path) as Uint8Array;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: options?.type ?? '' });
}

export default { createBlobFromFilePath };
