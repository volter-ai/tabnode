/**
 * What a read answers with. Node's `fs.readFileSync`, `fs.readFile` and
 * `fsPromises.readFile` hand back a `Buffer`, so every method of the class
 * is there: webpack's wasm hash calls `content.copy(memory, ...)` on the
 * bytes a loader was handed, and under the engine Next died compiling a page
 * with `TypeError: e.copy is not a function`, because a read answered with
 * the filesystem's own Uint8Array carrying one pinned `toString`. The bytes
 * are still the filesystem's own, viewed and not copied.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createFsShim } from '../src/shims/fs';
import { Buffer as GuestBuffer } from '../src/node-lib/buffer-module';

describe('a read answers with a Buffer, as Node does', () => {
  let vfs: VirtualFS;
  let fs: ReturnType<typeof createFsShim>;

  beforeEach(() => {
    vfs = new VirtualFS();
    vfs.mkdirSync('/test', { recursive: true });
    vfs.writeFileSync('/test/file.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    vfs.writeFileSync('/test/file.txt', 'hello world');
    fs = createFsShim(vfs);
  });

  it('readFileSync answers a Buffer that copies into another, as webpack hashes with', () => {
    const content = fs.readFileSync('/test/file.bin') as Buffer;
    expect(content).toBeInstanceOf(GuestBuffer);
    expect(typeof content.copy).toBe('function');
    const target = GuestBuffer.alloc(8, 0);
    const written = content.copy(target as unknown as Buffer, 0, 0, content.length);
    expect(written).toBe(8);
    expect(Array.from(target)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps the encodings a read answered with before', () => {
    const content = fs.readFileSync('/test/file.txt') as Buffer;
    expect(content.toString()).toBe('hello world');
    expect(content.toString('utf8')).toBe('hello world');
    expect(content.toString('hex')).toBe(Buffer.from('hello world').toString('hex'));
    expect(content.toString('base64')).toBe(Buffer.from('hello world').toString('base64'));
  });

  it('carries the rest of the class Node hands back', () => {
    const content = fs.readFileSync('/test/file.bin') as Buffer;
    expect(content.readUInt32BE(0)).toBe(0x01020304);
    expect(content.equals(GuestBuffer.from([1, 2, 3, 4, 5, 6, 7, 8]) as unknown as Uint8Array)).toBe(true);
    expect(content.length).toBe(8);
  });

  it('views the filesystem bytes rather than copying them', () => {
    const content = fs.readFileSync('/test/file.bin') as Buffer;
    expect(content.buffer).toBe((vfs.readFileSync('/test/file.bin') as Uint8Array).buffer);
  });

  it('answers a Buffer from the callback and the promise too', async () => {
    const fromCallback = await new Promise<Buffer>((resolve, reject) => {
      fs.readFile('/test/file.bin', (error: NodeJS.ErrnoException | null, data: Buffer) => (error ? reject(error) : resolve(data)));
    });
    expect(fromCallback).toBeInstanceOf(GuestBuffer);
    expect(typeof fromCallback.copy).toBe('function');
    const fromPromise = (await fs.promises.readFile('/test/file.bin')) as Buffer;
    expect(fromPromise).toBeInstanceOf(GuestBuffer);
    expect(typeof fromPromise.copy).toBe('function');
  });

  it('answers a Buffer from a descriptor read too', () => {
    const fd = fs.openSync('/test/file.bin', 'r');
    try {
      const content = fs.readFileSync(fd) as Buffer;
      expect(content).toBeInstanceOf(GuestBuffer);
      expect(typeof content.copy).toBe('function');
    } finally {
      fs.closeSync(fd);
    }
  });
});
