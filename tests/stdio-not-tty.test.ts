/**
 * A run's stdout that is not a TTY must not report colors: isTTY is false
 * unless the run was given a TTY, hasColors() is false there, and
 * console.log of a number is the digits, not CSI 33m.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('a pipe stdout does not colorize', () => {
  it('reports isTTY false, hasColors false, and console.log(6) is 6', () => {
    let captured = '';
    const fs = new VirtualFS();
    fs.mkdirSync('/w', { recursive: true });
    fs.writeFileSync('/w/n.js', `
      const util = require('util');
      console.log(6);
      module.exports = {
        isTTY: process.stdout.isTTY,
        hasColors: process.stdout.hasColors(),
        inspect: util.inspect(6),
        forceColor: process.env.FORCE_COLOR,
      };
    `);
    const runtime = new Runtime(fs, {
      cwd: '/w',
      env: { FORCE_COLOR: '1' },
      onConsole: (_method, args) => { captured += args.map(String).join(' ') + '\n'; },
      onStdout: (data) => { captured += data; },
    });
    const result = runtime.runFile('/w/n.js').exports as {
      isTTY: boolean; hasColors: boolean; inspect: string; forceColor: string | undefined;
    };
    expect(result.isTTY).toBe(false);
    expect(result.hasColors).toBe(false);
    expect(result.inspect).toBe('6');
    expect(result.forceColor).toBeUndefined();
    expect(captured.trim()).toBe('6');
    expect(captured).not.toMatch(/\u001b/);
  });

  it('inspects an Error on that pipe without throwing', () => {
    const fs = new VirtualFS();
    fs.mkdirSync('/w', { recursive: true });
    fs.writeFileSync('/w/e.js', `
      process.env.FORCE_COLOR = '1';
      const util = require('util');
      module.exports = util.inspect(new Error('x'));
    `);
    const runtime = new Runtime(fs, { cwd: '/w' });
    const text = runtime.runFile('/w/e.js').exports as string;
    expect(typeof text).toBe('string');
    expect(text).toContain('Error');
    expect(text).toContain('x');
  });
});
