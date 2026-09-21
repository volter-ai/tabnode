/**
 * `fs.glob`, `fs.globSync`, `fs.promises.glob`, `fs.opendir`, `fs.opendirSync`
 * and `fs.Dir`, driven from inside a Runtime the way a guest reaches them.
 *
 * The glob-to-RegExp helper used to be declared in `runtime.ts` and only
 * `declare`d in the fs shim, so `fs.globSync` threw
 * `__browserRuntimeNodeGlob is not defined` the first time a guest called it.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

/** A Runtime with a directory to work in, whose guest code answers a value. */
function guestWithFiles() {
  const fs = new VirtualFS();
  fs.mkdirSync('/work', { recursive: true });
  const runtime = new Runtime(fs, { cwd: '/work' });
  return (body: string) => runtime.execute(`module.exports = (() => { ${body} })();`, '/work/main.cjs').exports;
}

describe('fs globs its own tree and walks it with opendir', () => {
  it('answers the matches, streams the promise form and iterates a Dir', async () => {
    const run = guestWithFiles();
    expect(await run(`
      const fs = require("fs");
      const fsp = require("fs/promises");
      return (async () => {
        fs.mkdirSync("/work/tree/deep", { recursive: true });
        fs.writeFileSync("/work/tree/a.ts", "a");
        fs.writeFileSync("/work/tree/deep/b.ts", "b");
        fs.writeFileSync("/work/tree/deep/c.txt", "c");
        const streamed = [];
        for await (const match of fsp.glob("deep/*.txt", { cwd: "/work/tree" })) streamed.push(match);
        const entries = [];
        for await (const entry of fs.opendirSync("/work/tree")) entries.push(entry.name + ":" + entry.isDirectory());
        const dir = await fsp.opendir("/work/tree/deep");
        const first = await dir.read();
        return {
          globbed: fs.globSync("**/*.ts", { cwd: "/work/tree" }).sort(),
          streamed,
          entries: entries.sort(),
          firstName: typeof first.name
        };
      })();
    `)).toEqual({ globbed: ['a.ts', 'deep/b.ts'], streamed: ['deep/c.txt'], entries: ['a.ts:false', 'deep:true'], firstName: 'string' });
  });

  it('reads a Dir one entry at a time and closes it', () => {
    const run = guestWithFiles();
    expect(run(`
      const fs = require("fs");
      fs.mkdirSync("/work/pair", { recursive: true });
      fs.writeFileSync("/work/pair/one", "1");
      fs.writeFileSync("/work/pair/two", "2");
      const dir = fs.opendirSync("/work/pair");
      const names = [dir.readSync().name, dir.readSync().name].sort();
      const exhausted = dir.readSync();
      dir.closeSync();
      return { isDir: dir instanceof fs.Dir, path: dir.path, names, exhausted };
    `)).toEqual({ isDir: true, path: '/work/pair', names: ['one', 'two'], exhausted: null });
  });

  it("matches the patterns Node's glob does, and path.matchesGlob with them", () => {
    const run = guestWithFiles();
    expect(run(`
      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync("/work/g/a/b", { recursive: true });
      for (const name of ["/work/g/one.js", "/work/g/two.ts", "/work/g/a/three.js", "/work/g/a/b/four.js"]) fs.writeFileSync(name, "x");
      return {
        star: fs.globSync("*.js", { cwd: "/work/g" }),
        globstar: fs.globSync("**/*.js", { cwd: "/work/g" }).sort(),
        brace: fs.globSync("*.{js,ts}", { cwd: "/work/g" }).sort(),
        question: fs.globSync("a/thre?.js", { cwd: "/work/g" }),
        excluded: fs.globSync("**/*.js", { cwd: "/work/g", exclude: (name) => name.startsWith("a/") }).sort(),
        matches: [path.matchesGlob("a/b/four.js", "**/*.js"), path.matchesGlob("a/b/four.js", "*.js")]
      };
    `)).toEqual({
      star: ['one.js'],
      globstar: ['a/b/four.js', 'a/three.js', 'one.js'],
      brace: ['one.js', 'two.ts'],
      question: ['a/three.js'],
      excluded: ['one.js'],
      matches: [true, false],
    });
  });
});
