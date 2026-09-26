import { describe, expect, it } from 'vitest';
import { brotliCompressSync } from 'node:zlib';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('Brotli in the engine', () => {
  it('inflates a large pre-compressed file through a stream, as a server reading one does', { timeout: 60_000 }, async () => {
    const raw = new Uint8Array(12 * 1024 * 1024);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) >>> 27;
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/engine.bin.br', new Uint8Array(brotliCompressSync(raw)));
    const runtime = new Runtime(vfs, { cwd: '/app' });
    const result = runtime.execute(`
      const fs = require('fs'), zlib = require('zlib');
      module.exports = new Promise((resolve, reject) => {
        const parts = [];
        const startedAt = Date.now();
        fs.createReadStream('/app/engine.bin.br').pipe(zlib.createBrotliDecompress())
          .on('data', (chunk) => parts.push(chunk))
          .on('error', reject)
          .on('end', () => { fs.writeFileSync('/app/engine.bin', Buffer.concat(parts)); resolve(Date.now() - startedAt); });
      });
    `, '/app/inflate.js') as { exports: Promise<number> };
    const ms = await result.exports;
    // Byte-for-byte; a deep equality over 12 MB takes the test's whole deadline.
    expect(Buffer.compare(Buffer.from(vfs.readFileSync('/app/engine.bin') as Uint8Array), Buffer.from(raw))).toBe(0);
    console.log(`inflated ${raw.length} bytes in ${ms} ms`);
  });
});
