// `util._extend` is a shallow copy of an object's own enumerable keys. Node
// deprecated it in 2016 (DEP0060) and still exports it, and a package compiled
// years ago binds it at module scope: `next/dist/compiled/http-proxy` opens
// with `require('util')._extend`, so every external rewrite under `next dev`
// died with "s is not a function" before the request left the router.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import createContainer from '../src/index';
import { VirtualFS } from '../src/virtual-fs';

const PROGRAM = [
  "const util = require('util');",
  "const target = { kept: 1, over: 'before' };",
  "const same = util._extend(target, { over: 'after', added: 2 });",
  "console.log(JSON.stringify({",
  "  type: typeof util._extend,",
  "  returnsTarget: same === target,",
  "  merged: target,",
  "  fromNull: util._extend({ a: 1 }, null),",
  "  fromString: util._extend({ a: 1 }, 'bc'),",
  "  fromNumber: util._extend({ a: 1 }, 7),",
  "  ofArray: util._extend({}, ['x', 'y']),",
  "}));",
].join('\n');

function fromNode(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'extend-'));
  writeFileSync(join(dir, 'p.js'), PROGRAM);
  return JSON.parse(execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(join(dir, 'p.js'))}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } }).trim());
}

describe('util._extend', () => {
  it('copies what Node copies and ignores what Node ignores', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/app', { recursive: true });
    vfs.writeFileSync('/app/p.js', PROGRAM);
    let stdout = '';
    const result = await createContainer({ vfs }).run('node /app/p.js', { cwd: '/app', onStdout: (text: string) => { stdout += text; } });
    expect(result.exitCode, stdout).toBe(0);
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(seen).toEqual(fromNode());
    expect(seen.type).toBe('function');
    expect(seen.returnsTarget).toBe(true);
    expect(seen.merged).toEqual({ kept: 1, over: 'after', added: 2 });
    expect(seen.fromNull).toEqual({ a: 1 });
  }, 30_000);
});
