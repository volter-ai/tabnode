/**
 * `Buffer.isBuffer`, measured against the host's own Buffer: true for a
 * Buffer, false for a bare `Uint8Array`, an `ArrayBuffer`, a string and a
 * plain object. A program that branches on it to decide whether a view still
 * needs wrapping (VS Code's `VSBuffer.wrap`) reads its bytes back as
 * "91,93" when the engine says a bare view is already a Buffer.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

type GuestBufferModule = { imported: typeof Buffer; bare: typeof Buffer; global: typeof Buffer };

function guestBuffer(): GuestBufferModule {
  return new Runtime(new VirtualFS()).execute(
    'module.exports = {imported:require("buffer").Buffer, bare:Buffer, global:globalThis.Buffer};',
    '/buffer.cjs'
  ).exports as GuestBufferModule;
}

describe('Buffer.isBuffer answers as Node does', () => {
  it('is true only for a Buffer, on every door to the class', () => {
    const { imported, bare, global } = guestBuffer();
    for (const GuestBuffer of [imported, bare, global]) {
      expect(GuestBuffer.isBuffer(GuestBuffer.from('ab'))).toBe(Buffer.isBuffer(Buffer.from('ab')));
      expect(GuestBuffer.isBuffer(GuestBuffer.alloc(2).subarray(1))).toBe(true);
      expect(GuestBuffer.isBuffer(new Uint8Array([97, 98]))).toBe(Buffer.isBuffer(new Uint8Array([97, 98])));
      expect(GuestBuffer.isBuffer(new ArrayBuffer(2))).toBe(false);
      expect(GuestBuffer.isBuffer('ab')).toBe(false);
      expect(GuestBuffer.isBuffer({ length: 2 })).toBe(false);
      expect(GuestBuffer.isBuffer(undefined)).toBe(false);
    }
  });

  it('wraps a bare view the way a program that trusts isBuffer expects', () => {
    const { bare } = guestBuffer();
    const view = new Uint8Array([120, 91, 93, 121]).subarray(1, 3);
    const wrapped = bare.isBuffer(view) ? view : bare.from(view.buffer, view.byteOffset, view.byteLength);
    expect(wrapped.toString()).toBe('[]');
  });
});
