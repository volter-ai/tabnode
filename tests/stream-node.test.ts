/**
 * The stream shim against Node's own streams, event for event.
 *
 * Node is the reference: each scenario below runs once on `node:stream` in
 * this process and once on the guest's `stream`, and the guest's sequence of
 * events must be Node's. The shapes are the ones packages construct streams
 * in: `new Readable({ read })`, `new Writable({ write, final })`,
 * `new Transform({ transform, flush })`, `new Duplex({ read, write })`, a
 * PassThrough written before its reader exists and replayed from a `read`
 * (Next's ReplayableNodeStream, whose consumer waited forever), and byte
 * views that Node hands on as Buffers.
 */

import { describe, it, expect } from 'vitest';
import * as nodeStream from 'node:stream';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

type StreamModule = typeof nodeStream;

function guestStream(): StreamModule {
  return new Runtime(new VirtualFS()).execute(
    'module.exports = require("node:stream");',
    '/stream.cjs'
  ).exports as StreamModule;
}

const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function scenario(stream: StreamModule): Promise<string[]> {
  const { Readable, Writable, Transform, Duplex, PassThrough } = stream;
  const seen: string[] = [];
  const text = (chunk: unknown) => `${chunk}`;

  // A pull stream implemented in its options.
  const r = new Readable({ read() { seen.push('read'); this.push('a'); this.push(null); } });
  r.on('data', (chunk) => seen.push(`data:${text(chunk)}`));
  r.on('end', () => seen.push('end'));
  r.on('close', () => seen.push('rclose'));

  // A sink implemented in its options: write, then final, then finish.
  const w = new Writable({
    write(chunk, _encoding, callback) { seen.push(`write:${text(chunk)}`); callback(); },
    final(callback) { seen.push('final'); callback(); },
  });
  w.on('finish', () => seen.push('finish'));
  w.on('close', () => seen.push('wclose'));
  w.write('b', () => seen.push('wrote:b'));
  seen.push('after-write:b');
  w.end('b2', () => seen.push('ended'));

  // A transform implemented in its options, its flush after the last chunk.
  const t = new Transform({
    transform(chunk, _encoding, callback) { seen.push(`transform:${text(chunk)}`); callback(null, chunk); },
    flush(callback) { seen.push('flush'); callback(); },
  });
  t.on('data', (chunk) => seen.push(`tdata:${text(chunk)}`));
  t.on('end', () => seen.push('tend'));
  t.on('close', () => seen.push('tclose'));
  t.end('c');

  // A transform whose callback comes later still ends after its last chunk.
  const slow = new Transform({
    transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 2); },
    flush(callback) { seen.push('slow-flush'); callback(); },
  });
  slow.on('data', (chunk) => seen.push(`slow:${text(chunk)}`));
  slow.on('end', () => seen.push('slow-end'));
  slow.write('s1');
  slow.end('s2');

  // Both sides implemented in one options object.
  const d = new Duplex({
    read() { seen.push('dread'); this.push(null); },
    write(chunk, _encoding, callback) { seen.push(`dwrite:${text(chunk)}`); callback(); },
  });
  d.on('end', () => seen.push('dend'));
  d.resume();
  d.end('e');

  // Next's replay: chunks buffered from a PassThrough before any consumer,
  // handed on from `read` to a Readable made afterwards.
  const source = new PassThrough();
  const buffered: unknown[] = [];
  source.on('data', (chunk) => buffered.push(chunk));
  source.write(new Uint8Array([0x68, 0x69]));
  source.end();
  await settle(5);
  let drained = false;
  const replay = new Readable({
    read() {
      if (drained) return;
      drained = true;
      for (const chunk of buffered) this.push(chunk as Uint8Array);
      this.push(null);
    },
  });
  const reader = Readable.toWeb(replay).getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) { seen.push('replay-done'); break; }
    seen.push(`replay:${new TextDecoder().decode(step.value as Uint8Array)}`);
  }

  // A byte view written to a stream is a Buffer to its reader.
  const bytes = new PassThrough();
  bytes.on('data', (chunk) => seen.push(`bytes:${text(chunk)}:${typeof (chunk as { toString(encoding: string): string }).toString === 'function' && (chunk as { toString(encoding: string): string }).toString('hex')}`));
  bytes.end(new Uint8Array([0x6f, 0x6b]));

  // Two sources chained into one sink, each piped with `{ end: false }` and
  // the sink ended by hand once the last source has ended.
  const sink = new PassThrough();
  sink.on('data', (chunk) => seen.push(`chain:${text(chunk)}`));
  sink.on('end', () => seen.push('chain-end'));
  const first = new PassThrough();
  const second = new PassThrough();
  first.pipe(sink, { end: false });
  first.on('end', () => {
    seen.push('chain-first-ended');
    second.pipe(sink, { end: false });
    second.on('end', () => { seen.push('chain-second-ended'); sink.end(); });
  });
  first.end('one');
  setTimeout(() => second.end('two'), 5);

  await settle();
  return seen;
}

/**
 * Each stream's own events, in order. The interleaving between streams is
 * Node's tick order, which the engine's microtasks approximate; what a
 * program depends on is the order within one stream.
 */
function byStream(seen: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const event of seen) {
    const name = /^(data|read|end|rclose)$|^data:/u.test(event) ? 'readable'
      : /^(write|wrote|after-write|final|finish|ended|wclose)/u.test(event) ? 'writable'
      : /^(transform|tdata|flush|tend|tclose)/u.test(event) ? 'transform'
      : /^slow/u.test(event) ? 'slow-transform'
      : /^d(read|write|end)/u.test(event) ? 'duplex'
      : /^replay/u.test(event) ? 'replay'
      : /^chain/u.test(event) ? 'chain' : 'bytes';
    (groups[name] ??= []).push(event);
  }
  return groups;
}

describe('streams against Node', () => {
  it('a stream built from its options behaves as Node runs it, event for event', async () => {
    const expected = await scenario(nodeStream);
    const actual = await scenario(guestStream());
    expect(byStream(actual)).toEqual(byStream(expected));
    // The expectations that carry this test, stated so a change to Node's
    // side of it is seen: the pull ran, the sink finalized, the flush came
    // after the last chunk, the replay reached its reader.
    expect(expected).toContain('read');
    expect(byStream(expected).readable).toEqual(['read', 'data:a', 'end', 'rclose']);
    expect(byStream(expected).transform.slice(-2)).toEqual(['tend', 'tclose']);
    expect(byStream(expected).writable.slice(-1)).toEqual(['wclose']);
    expect(expected).toContain('final');
    expect(expected.indexOf('flush')).toBeGreaterThan(expected.indexOf('transform:c'));
    expect(expected).toContain('replay:hi');
    expect(expected).toContain('bytes:ok:6f6b');
    expect(byStream(expected).chain).toEqual(['chain:one', 'chain-first-ended', 'chain:two', 'chain-second-ended', 'chain-end']);
  });
});
