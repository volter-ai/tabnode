import { describe, expect, it } from 'vitest';
import { __substrateParseFrames, type FrameState } from '../src/server-bridge';

/** A frame as a peer writes it: FIN set, the length in its shortest form, masked when asked. */
function frame(opcode: number, payload: Uint8Array, options: { fin?: boolean; mask?: number[] } = {}): Uint8Array {
  const length = payload.length;
  const head = [(options.fin === false ? 0 : 0x80) | opcode];
  const maskBit = options.mask ? 0x80 : 0;
  if (length < 126) head.push(maskBit | length);
  else if (length < 65536) head.push(maskBit | 126, length >> 8, length & 255);
  else head.push(maskBit | 127, 0, 0, 0, 0, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255);
  const out = new Uint8Array(head.length + (options.mask ? 4 : 0) + length);
  out.set(head, 0);
  if (options.mask) out.set(options.mask, head.length);
  const start = head.length + (options.mask ? 4 : 0);
  for (let index = 0; index < length; index += 1) out[start + index] = options.mask ? payload[index]! ^ options.mask[index & 3]! : payload[index]!;
  return out;
}

function parser(): { state: FrameState; frames: Array<[number, string]>; feed(chunk: Uint8Array): void } {
  const state: FrameState = { pending: [], pendingBytes: 0, needed: 0, fragments: null };
  const frames: Array<[number, string]> = [];
  const decoder = new TextDecoder();
  return { state, frames, feed: (chunk) => __substrateParseFrames(state, chunk, (opcode, payload) => frames.push([opcode, decoder.decode(payload)])) };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('the bridge reading a server\'s WebSocket frames', () => {
  it('reads the same messages wherever the stream is cut', () => {
    const stream = new Uint8Array([...frame(1, text('one')), ...frame(2, text('x'.repeat(300))), ...frame(1, text('three'), { mask: [9, 8, 7, 6] })]);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const reader = parser();
      reader.feed(stream.subarray(0, cut));
      reader.feed(stream.subarray(cut));
      expect(reader.frames, `cut at ${cut}`).toEqual([[1, 'one'], [2, 'x'.repeat(300)], [1, 'three']]);
      expect(reader.state.pendingBytes).toBe(0);
    }
  });

  it('reads a frame larger than a chunk once it has all arrived', () => {
    const body = 'abcdefghij'.repeat(20_000);
    const stream = new Uint8Array([...frame(1, text(body)), ...frame(1, text('after'))]);
    const reader = parser();
    for (let offset = 0; offset < stream.length; offset += 1024) {
      reader.feed(stream.subarray(offset, offset + 1024));
      if (offset + 1024 < stream.length - 7) expect(reader.frames).toEqual([]);
    }
    expect(reader.frames).toEqual([[1, body], [1, 'after']]);
  });

  it('joins a fragmented message', () => {
    const reader = parser();
    reader.feed(frame(1, text('hel'), { fin: false }));
    reader.feed(frame(0, text('lo')));
    expect(reader.frames).toEqual([[1, 'hello']]);
  });

  it('keeps nothing of a caller\'s buffer, which the caller may reuse', () => {
    const stream = frame(1, text('y'.repeat(2000)));
    const reader = parser();
    const buffer = new Uint8Array(1000);
    for (let offset = 0; offset < stream.length; offset += 1000) {
      const piece = stream.subarray(offset, offset + 1000);
      buffer.set(piece);
      reader.feed(buffer.subarray(0, piece.length));
      buffer.fill(0);
    }
    expect(reader.frames).toEqual([[1, 'y'.repeat(2000)]]);
  });
});

describe('a frame larger than the page takes', () => {
  it('is answered as a close with 1009 and nothing is kept', () => {
    const reader = parser();
    // A 64-bit length of 2^32 bytes, header only.
    reader.feed(new Uint8Array([0x82, 127, 0, 0, 0, 1, 0, 0, 0, 0]));
    expect(reader.frames).toEqual([[8, new TextDecoder().decode(new Uint8Array([0x03, 0xf1]))]]);
    expect(reader.state.pendingBytes).toBe(0);
  });
});
