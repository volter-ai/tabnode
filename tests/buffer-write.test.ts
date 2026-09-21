/**
 * `Buffer.prototype.write` and `Buffer.from` over memory, measured against
 * the host's own Buffer: a Buffer made over an ArrayBuffer or a
 * SharedArrayBuffer is a view that writes through, every form of write's
 * arguments lands where Node's does, and neither a byte limit nor the end of
 * the buffer is crossed.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

type GuestBufferModule = {
  imported: typeof Buffer;
  bare: typeof Buffer;
  global: typeof Buffer;
};

function guestBuffer(): GuestBufferModule {
  return new Runtime(new VirtualFS()).execute(
    'module.exports = {imported:require("buffer").Buffer, bare:Buffer, global:globalThis.Buffer};',
    '/buffer.cjs'
  ).exports as GuestBufferModule;
}

describe('Buffer writes respect shared-memory views, UTF-16 encoding, and byte limits', () => {
  it('is one Buffer for the module, the free name and the global', () => {
    const result = guestBuffer();
    expect(result.bare).toBe(result.imported);
    expect(result.global).toBe(result.imported);
  });

  for (const Memory of [ArrayBuffer, SharedArrayBuffer]) {
    it(`views ${Memory.name} and writes through it exactly as Node does`, () => {
      const GuestBuffer = guestBuffer().imported;
      const actual = new Memory(128);
      const expected = new Memory(128);
      new Uint8Array(actual as ArrayBuffer).fill(0x7f);
      new Uint8Array(expected as ArrayBuffer).fill(0x7f);
      const guest = GuestBuffer.from(actual as ArrayBuffer, 24, 40);
      const native = Buffer.from(expected as ArrayBuffer, 24, 40);
      expect(guest.byteOffset).toBe(24);
      expect(guest.length).toBe(40);

      // A whole string in UTF-16, which is two bytes a code unit.
      expect(guest.write('héllo 🌍', 'utf16le')).toBe(native.write('héllo 🌍', 'utf16le'));
      expect([...new Uint8Array(actual as ArrayBuffer)]).toEqual([...new Uint8Array(expected as ArrayBuffer)]);

      // Three bytes of room for a two-byte character and a four-byte one: the
      // four-byte one does not fit, and no half of it is written.
      expect(guest.write('é🌍', 30, 3, 'utf8')).toBe(native.write('é🌍', 30, 3, 'utf8'));
      expect([...new Uint8Array(actual as ArrayBuffer)]).toEqual([...new Uint8Array(expected as ArrayBuffer)]);

      expect(() => GuestBuffer.from(actual as ArrayBuffer, 120, 20)).toThrow(RangeError);
    });
  }

  it('encodes and decodes UTF-16 the way Node does', () => {
    const GuestBuffer = guestBuffer().imported;
    expect([...GuestBuffer.from('héllo 🌍', 'utf16le')]).toEqual([...Buffer.from('héllo 🌍', 'utf16le')]);
    expect([...GuestBuffer.from('héllo 🌍', 'ucs2')]).toEqual([...Buffer.from('héllo 🌍', 'ucs2')]);
    expect(GuestBuffer.from('héllo 🌍', 'utf16le').toString('utf16le')).toBe('héllo 🌍');
    expect(GuestBuffer.byteLength('héllo 🌍', 'utf16le')).toBe(Buffer.byteLength('héllo 🌍', 'utf16le'));
    expect(GuestBuffer.isEncoding('ucs-2')).toBe(true);
  });

  it('answers what Node answers for every form of write', () => {
    const GuestBuffer = guestBuffer().imported;
    const cases: Array<[string, unknown[]]> = [
      ['abc', []],
      ['abcdefghijklmnop', []],
      ['héllo', ['utf8']],
      ['ab', [2]],
      ['ab', [2, 'utf8']],
      ['abcdef', [4, 2]],
      ['abcdef', [4, 2, 'utf8']],
      ['é🌍', [0, 3, 'utf8']],
      ['hi', [0, 'utf16le']],
      ['hi', [0, 3, 'utf16le']],
      ['ff00aa', [1, 'hex']],
      ['ff00aa', [0, 2, 'hex']],
      ['ffzz', [0, 'hex']],
      ['aGVsbG8=', [0, 'base64']],
      ['aGVsbG8=', [0, 2, 'base64']],
      ['héllo', [0, 'latin1']],
      ['abc', [8]],
      ['abc', [0, 0]],
    ];
    for (const [text, args] of cases) {
      const guest = GuestBuffer.alloc(8, 0x7f);
      const native = Buffer.alloc(8, 0x7f);
      const label = `${JSON.stringify(text)} ${JSON.stringify(args)}`;
      expect((guest.write as (...a: unknown[]) => number)(text, ...args), label).toBe(
        (native.write as (...a: unknown[]) => number)(text, ...args)
      );
      expect([...guest], label).toEqual([...native]);
    }
  });

  it('refuses an offset past the end and an encoding it does not know', () => {
    const GuestBuffer = guestBuffer().imported;
    expect(() => GuestBuffer.alloc(4).write('a', 5)).toThrow(RangeError);
    expect(() => GuestBuffer.alloc(4).write('a', 0, 1, 'klingon')).toThrow(TypeError);
  });

  it('shares memory with the view it was made from', () => {
    const GuestBuffer = guestBuffer().imported;
    const memory = new ArrayBuffer(16);
    const view = GuestBuffer.from(memory, 4, 8);
    view.write('abcd');
    expect([...new Uint8Array(memory).subarray(4, 8)]).toEqual([97, 98, 99, 100]);
    new Uint8Array(memory)[4] = 0x7a;
    expect(view[0]).toBe(0x7a);
  });
});
