// The five stream constructors, inherited from the way npm has always
// inherited from them: `function Mine(options) { Transform.call(this, options); }`
// with `util.inherits`. The engine defined them as ES classes, which refuse a
// call -- "Class constructor Transform cannot be invoked without 'new'" -- so
// every such subclass threw on its first instance; byline, through which
// Prisma's own code generator reads its JSON-RPC requests, died there before
// the generator printed a line. Node defines all five as function
// constructors, and what Node answers for the same programs is the measure
// here: the same bodies run under the host's `node` and under the engine, and
// the answers are compared field for field.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { Runtime, VirtualFS } from '../src/index';

function guest(): (body: string) => unknown {
  const fs = new VirtualFS();
  fs.mkdirSync('/g', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/g' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/g/main.cjs').exports;
}

/** What Node itself answers, run through a login shell so it is the host's node. */
function node(body: string): unknown {
  // One line: the body crosses a shell, where a newline inside the quoted
  // program is a line of its own.
  const one = body.split('\n').map((line) => line.trim()).join(' ');
  const out = execFileSync('/bin/sh', ['-lc', `node -e ${JSON.stringify(`Promise.resolve((() => { ${one} })()).then((value) => console.log(JSON.stringify(value)))`)}`], {
    encoding: 'utf8',
    env: { HOME: userInfo().homedir },
  });
  return JSON.parse(out.trim());
}

const names = ['Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough', 'Stream'];

describe('a stream subclassed the way npm subclasses streams', () => {
  const inherits = `
    const stream = require('stream');
    const util = require('util');
    const out = {};
    for (const name of ${JSON.stringify(names)}) {
      const Base = stream[name];
      try {
        function Mine(options) { Base.call(this, options); }
        util.inherits(Mine, Base);
        const made = new Mine({});
        out[name] = { ofSubclass: made instanceof Mine, ofBase: made instanceof Base, emitter: typeof made.on };
      } catch (error) { out[name] = { error: error.message }; }
    }
    return out;
  `;

  it('takes a `.call` on every one of the five, as Node does', () => {
    const expected: Record<string, unknown> = {};
    for (const name of names) expected[name] = { ofSubclass: true, ofBase: true, emitter: 'function' };
    expect(guest()(inherits)).toEqual(expected);
    expect(node(inherits)).toEqual(expected);
  });

  // `Stream` itself is left out here: Node's `Stream` has no `instanceof`
  // guard, so `stream.Stream({})` returns undefined on Node where the
  // engine's self-constructs. That divergence is the engine being more
  // forgiving than Node, it predates this lane, and it is not corrected by
  // making the engine throw.
  const constructs = `
    const stream = require('stream');
    const out = {};
    for (const name of ${JSON.stringify(names.filter((name) => name !== 'Stream'))}) {
      try {
        const made = stream[name]({});
        out[name] = { object: typeof made === 'object' && made !== null, ofBase: made instanceof stream[name] };
      } catch (error) { out[name] = { error: error.message }; }
    }
    return out;
  `;

  it('constructs when called with no `new` at all, as Node\'s function constructors do', () => {
    const expected: Record<string, unknown> = {};
    for (const name of names.filter((name) => name !== 'Stream')) expected[name] = { object: true, ofBase: true };
    expect(guest()(constructs)).toEqual(expected);
    expect(node(constructs)).toEqual(expected);
  });

  // The point of the fix is not the shape but that such a stream runs: the
  // subclass's `_transform` is reached, in order, and `end` closes the
  // readable side after the last chunk has been through.
  const runs = `
    const stream = require('stream');
    const util = require('util');
    function Upper(options) { stream.Transform.call(this, options); }
    util.inherits(Upper, stream.Transform);
    Upper.prototype._transform = function (chunk, encoding, callback) { callback(null, String(chunk).toUpperCase()); };
    const upper = new Upper();
    const seen = [];
    upper.on('data', (chunk) => seen.push(String(chunk)));
    return new Promise((resolve) => {
      upper.on('end', () => resolve({ seen, readable: upper.readable, ended: upper.readableEnded }));
      upper.write('ab');
      upper.write('cd');
      upper.end();
    });
  `;

  it('runs its own `_transform` over every chunk and then ends, as Node does', async () => {
    expect(await guest()(runs)).toEqual({ seen: ['AB', 'CD'], readable: false, ended: true });
    expect(node(runs)).toEqual({ seen: ['AB', 'CD'], readable: false, ended: true });
  });

  // byline's own guard, which is the report this lane started from: it refuses
  // anything that is not a `stream.Readable` before it reads a byte.
  const guard = `
    const stream = require('stream');
    const util = require('util');
    function Lines(input, options) { if (!(input instanceof stream.Readable)) throw new Error('expected Readable'); stream.Transform.call(this, options); this.input = input; }
    util.inherits(Lines, stream.Transform);
    try { const lines = new Lines(new stream.PassThrough()); return { built: lines instanceof stream.Transform }; } catch (error) { return { error: error.message }; }
  `;

  it('lets a wrapper that checks `instanceof Readable` and calls `Transform` be built, as Node does', () => {
    expect(guest()(guard)).toEqual({ built: true });
    expect(node(guard)).toEqual({ built: true });
  });

  // Node keeps the statics down the chain (`Readable.from` is reachable from
  // `Duplex`), and a subclass's prototype chain reaches the base's methods.
  const statics = `
    const stream = require('stream');
    return {
      readableFrom: typeof stream.Readable.from,
      duplexIsReadable: stream.Duplex.prototype instanceof stream.Readable,
      transformIsDuplex: stream.Transform.prototype instanceof stream.Duplex,
      passThroughIsTransform: stream.PassThrough.prototype instanceof stream.Transform,
      ctorOfReadable: stream.Readable.prototype.constructor === stream.Readable,
    };
  `;

  it('keeps the chain and the statics Node keeps', () => {
    const expected = { readableFrom: 'function', duplexIsReadable: true, transformIsDuplex: true, passThroughIsTransform: true, ctorOfReadable: true };
    expect(guest()(statics)).toEqual(expected);
    expect(node(statics)).toEqual(expected);
  });
});
