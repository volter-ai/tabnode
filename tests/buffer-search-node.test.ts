/**
 * The guest Buffer's indexOf, lastIndexOf and includes against Node's own,
 * needle for needle: a string in an encoding, a byte view, a number, with
 * offsets forward, negative and out of range. Node's answer is the
 * expectation; Next's HTML transforms search a chunk for `</head>` as a
 * byte view and had never found it.
 */

import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

type GuestBuffer = typeof Buffer;

function guestBuffer(): GuestBuffer {
  return new Runtime(new VirtualFS()).execute('module.exports = Buffer;', '/buffer.cjs').exports as GuestBuffer;
}

describe('Buffer search against Node', () => {
  it('indexOf, lastIndexOf and includes answer as Node does for strings, byte views and numbers', () => {
    const Guest = guestBuffer();
    const text = '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>héllo</body></html>';
    const cases: Array<[unknown, (number | string)?, string?]> = [
      ['</head>'], [new TextEncoder().encode('</head>')], [Buffer.from('</head>')], [60], [0x3c + 256], ['<'],
      ['</head>', 10], ['</head>', -30], ['</head>', 1000], ['</head>', -1000], ['h', 'utf8'], ['é'], ['é', 'latin1'],
      [new Uint8Array([0x3c, 0x2f])], [new Uint8Array(0)], [new Uint8Array(0), 5], ['', -3], ['missing'], [new Uint8Array([1, 2, 3])],
      ['</head>', Number.NaN], ['<html>', 0, 'utf8'],
    ];
    for (const [value, offset, encoding] of cases) {
      const guest = Guest.from(text);
      const native = Buffer.from(text);
      for (const method of ['indexOf', 'lastIndexOf', 'includes'] as const) {
        const args = [value, offset, encoding].filter((argument) => argument !== undefined);
        expect((guest[method] as (...a: unknown[]) => unknown)(...args), `${method}(${JSON.stringify(args)})`)
          .toBe((native[method] as (...a: unknown[]) => unknown)(...args));
      }
    }
    expect(() => Guest.from(text).indexOf({} as unknown as string)).toThrow(TypeError);
  });
});
