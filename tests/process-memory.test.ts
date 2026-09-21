// `process.constrainedMemory` and `process.availableMemory` are functions on
// Node and the engine had neither, so a library that asks either one for a
// pool size died on `undefined is not a function` before it had done anything.
// The MariaDB driver, which Prisma's MySQL adapter wraps, is one such library:
// it reads `constrainedMemory` while loading, so it could not even be imported
// in a tab. Measured 2026-09-16 in a browser.
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
  const one = body.split('\n').map((line) => line.trim()).join(' ');
  const out = execFileSync('/bin/sh', ['-lc', `node -e ${JSON.stringify(`console.log(JSON.stringify((() => { ${one} })()))`)}`], {
    encoding: 'utf8',
    env: { HOME: userInfo().homedir },
  });
  return JSON.parse(out.trim());
}

describe('process memory reporting', () => {
  it('both are functions, where the engine had nothing to call', () => {
    for (const name of ['constrainedMemory', 'availableMemory']) {
      expect(guest()(`return typeof process.${name}`), name).toBe('function');
      expect(node(`return typeof process.${name}`), name).toBe('function');
    }
  });

  it('a tab is in no cgroup, so its constraint is Node\'s own answer for none', () => {
    expect(guest()('return process.constrainedMemory()')).toBe(0);
    // This host is unconstrained too, which is the case every ordinary machine
    // presents and every caller therefore already handles.
    expect(node('return process.constrainedMemory()')).toBe(0);
  });

  it('available memory is a positive byte count, as Node\'s is', () => {
    const guestSaid = guest()('return process.availableMemory()') as number;
    const nodeSaid = node('return process.availableMemory()') as number;
    for (const [what, value] of [['guest', guestSaid], ['node', nodeSaid]] as const) {
      expect(Number.isInteger(value), what).toBe(true);
      expect(value, what).toBeGreaterThan(0);
    }
  });

  it('the engine has one answer about memory, not two that can drift', () => {
    expect(guest()('return process.availableMemory() === require("os").freemem()')).toBe(true);
  });
});
