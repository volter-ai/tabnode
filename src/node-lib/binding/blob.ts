/**
 * `internalBinding('blob')`: `fs.openAsBlob`'s read, and the process's blob URL registry (`node_blob.cc`'s
 * `storeDataObject`, `getDataObject`, `revokeObjectURL`, one per realm, which is one per process).
 *
 * Node's `internal/blob` reads the file through this binding and answers a
 * Blob of the realm. The engine has no C++ blob handle, so the bytes come
 * off the same tree the fs binding reads -- the run's filesystem, hung off
 * the guest process under the same key -- and the Blob is the realm's own,
 * which is also what the registry holds for a `blob:nodedata:` URL.
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

/** One process's registry: `URL.createObjectURL`'s id, the Blob it names, its length and type. */
export function createBlobBinding() {
  const stored = new Map<string, [Blob, number, string]>();
  return {
    createBlobFromFilePath,
    storeDataObject(id: string, blob: Blob, length: number, type: string): void { stored.set(id, [blob, length, type]); },
    getDataObject(id: string): [Blob, number, string] | undefined { return stored.get(id); },
    /** `node_blob.cc` RevokeObjectURL: the id is the pathname after its one colon (`nodedata:<id>`). */
    revokeObjectURL(input: string): void {
      let pathname: string;
      try { pathname = new URL(input).pathname; } catch { return; }
      const start = pathname.indexOf(':');
      if (start < 0 || start === pathname.length || pathname.indexOf(':', start + 1) >= 0) return;
      stored.delete(pathname.slice(start + 1));
    },
  };
}
export type BlobBinding = ReturnType<typeof createBlobBinding>;

export default createBlobBinding();
