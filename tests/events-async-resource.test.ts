/**
 * EventEmitterAsyncResource is a class whose instances are emitters: Node's
 * events.js builds it from the async_hooks AsyncResource, which answers a
 * positive asyncId.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('EventEmitterAsyncResource', () => {
  it('is an EventEmitter whose asyncId is a positive id', async () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/g', { recursive: true });
    const runtime = new Runtime(fs, { cwd: '/g' });
    const result = await runtime.execute(`module.exports = (() => {
      const events = require('events');
      const named = new events.EventEmitterAsyncResource({ name: 'queue' });
      return {
        resourceIsEmitter: named instanceof events.EventEmitter && named.asyncId > 0,
        asyncId: named.asyncId,
      };
    })();`, '/g/main.cjs').exports as { resourceIsEmitter: boolean; asyncId: number };
    expect(result.resourceIsEmitter).toBe(true);
    expect(result.asyncId).toBeGreaterThan(0);
  });
});
