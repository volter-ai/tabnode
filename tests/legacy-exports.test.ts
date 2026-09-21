import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

function guest(code: string): unknown {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  return new Runtime(vfs, { cwd: '/app' }).execute(code, '/app/entry.js').exports;
}

describe('the exports Node keeps though deprecated', () => {
  it('fs names the access modes at the top level', () => {
    expect(guest('const fs = require("fs"); module.exports = [fs.F_OK, fs.R_OK, fs.W_OK, fs.X_OK];')).toEqual([0, 4, 2, 1]);
  });
  it('timers enrolls, activates and unenrolls an item', async () => {
    const result = guest(`const timers = require("timers");
      const item = { fired: 0, _onTimeout() { this.fired += 1; } };
      timers.enroll(item, 5); timers.active(item);
      const second = { fired: 0, _onTimeout() { this.fired += 1; } };
      timers.enroll(second, 5); timers.active(second); timers.unenroll(second);
      module.exports = new Promise((resolve) => setTimeout(() => resolve([item.fired, second.fired, second._idleTimeout]), 30));`) as Promise<unknown>;
    expect(await result).toEqual([1, 0, -1]);
  });
  it('util.isSymbol and util.log exist as Node has them', () => {
    const [isSymbol, notSymbol, logType] = guest('const util = require("util"); module.exports = [util.isSymbol(Symbol("x")), util.isSymbol("x"), typeof util.log];') as unknown[];
    expect([isSymbol, notSymbol, logType]).toEqual([true, false, 'function']);
  });
  it('process.assert throws on a falsy value with the message', () => {
    const outcome = guest('try { process.assert(0, "no"); module.exports = "passed"; } catch (e) { module.exports = e.name + ":" + e.message + ":" + e.code; } process.assert(1);');
    expect(outcome).toBe('AssertionError:no:ERR_ASSERTION');
  });
  it('assert.CallTracker counts calls and reports the shortfall', () => {
    const outcome = guest(`const assert = require("assert");
      const tracker = new assert.CallTracker();
      const once = tracker.calls(() => 1, 2);
      once();
      const report = tracker.report();
      let threw = null; try { tracker.verify(); } catch (e) { threw = e.message; }
      once();
      tracker.verify();
      module.exports = [report.length, report[0].actual, report[0].expected, threw !== null, tracker.getCalls(once).length];`);
    expect(outcome).toEqual([1, 1, 2, true, 2]);
  });
});
