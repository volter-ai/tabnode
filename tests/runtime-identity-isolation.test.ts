/**
 * Two engine instances in one realm keep their own trees.
 *
 * `verify:consumer` creates two runtimes over two filesystems, writes
 * FIRST and SECOND to each `/identity`, and runs `node /main.cjs` in each.
 * `main.cjs` prints `require("./read.cjs")`, which reads `/identity`. The
 * first runtime printed SECOND: the loader's vendored-module cache and the
 * `node` command's tree are module-scope singletons, so the second instance
 * is the one both runs see.
 *
 * The guest also tags `require('fs')` with `Symbol.for`, prints
 * `process.pid`, and writes `/probe` so the host can see whether the two
 * runs share one `fs` module and which tree received the write.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer, Runtime } from '../src/index';

const READ_CJS = 'module.exports = require("fs").readFileSync("/identity", "utf8");';
const MAIN_CJS = `
const fs = require("fs");
const tag = Symbol.for("tabnode.fs.identity");
if (fs[tag] === undefined) fs[tag] = [];
fs[tag].push(String(process.pid));
fs.writeFileSync("/probe", String(process.pid));
console.log(require("./read.cjs"));
console.log("pid=" + process.pid);
console.log("fsOwners=" + fs[tag].join(","));
`;

function writeGuest(tree: VirtualFS, identity: string): void {
  tree.writeFileSync('/identity', identity);
  tree.writeFileSync('/read.cjs', READ_CJS);
  tree.writeFileSync('/main.cjs', MAIN_CJS);
}

describe('two runtimes over two trees', () => {
  it('each node /main.cjs prints its own identity, its own pid, and writes /probe on its own tree', async () => {
    const firstTree = new VirtualFS();
    const secondTree = new VirtualFS();
    writeGuest(firstTree, 'FIRST');
    writeGuest(secondTree, 'SECOND');

    const first = createContainer({ vfs: firstTree });
    const second = createContainer({ vfs: secondTree });

    const firstRun = await first.run('node /main.cjs');
    const secondRun = await second.run('node /main.cjs');

    const firstLines = firstRun.stdout.trim().split('\n');
    const secondLines = secondRun.stdout.trim().split('\n');

    expect(firstRun.exitCode).toBe(0);
    expect(secondRun.exitCode).toBe(0);
    expect(firstLines[0]).toBe('FIRST');
    expect(secondLines[0]).toBe('SECOND');
    expect(firstTree.existsSync('/probe')).toBe(true);
    expect(secondTree.existsSync('/probe')).toBe(true);
    expect(firstTree.readFileSync('/probe', 'utf8')).toBe(firstLines[1]!.slice('pid='.length));
    expect(secondTree.readFileSync('/probe', 'utf8')).toBe(secondLines[1]!.slice('pid='.length));
    expect(firstLines[1]).not.toBe(secondLines[1]);
    expect(firstLines[2]!.startsWith('fsOwners=')).toBe(true);
    expect(secondLines[2]!.startsWith('fsOwners=')).toBe(true);
    expect(secondLines[2]).not.toContain(',');
  }, 20_000);

  it('Runtime.execute over two trees answers each tree’s identity through the same require("fs") door', () => {
    const firstTree = new VirtualFS();
    const secondTree = new VirtualFS();
    firstTree.writeFileSync('/identity', 'FIRST');
    secondTree.writeFileSync('/identity', 'SECOND');

    const firstOut: string[] = [];
    const secondOut: string[] = [];
    const first = new Runtime(firstTree, { onConsole: (_method, args) => { firstOut.push(args.map(String).join(' ')); } });
    const second = new Runtime(secondTree, { onConsole: (_method, args) => { secondOut.push(args.map(String).join(' ')); } });

    first.execute(`
      const fs = require("fs");
      const tag = Symbol.for("tabnode.fs.identity");
      fs[tag] = "FIRST";
      fs.writeFileSync("/probe", "FIRST");
      console.log(require("fs").readFileSync("/identity", "utf8"));
      console.log("pid=" + process.pid);
      console.log("fsTag=" + fs[tag]);
    `, '/main.cjs');
    second.execute(`
      const fs = require("fs");
      const tag = Symbol.for("tabnode.fs.identity");
      const previous = fs[tag];
      fs[tag] = "SECOND";
      fs.writeFileSync("/probe", "SECOND");
      console.log(require("fs").readFileSync("/identity", "utf8"));
      console.log("pid=" + process.pid);
      console.log("fsTag=" + fs[tag] + " previous=" + previous);
    `, '/main.cjs');

    expect(firstOut[0]).toBe('FIRST');
    expect(secondOut[0]).toBe('SECOND');
    expect(firstTree.readFileSync('/probe', 'utf8')).toBe('FIRST');
    expect(secondTree.readFileSync('/probe', 'utf8')).toBe('SECOND');
    expect(secondOut[2]).toBe('fsTag=SECOND previous=undefined');
  });
});
