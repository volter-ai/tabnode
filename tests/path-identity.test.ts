import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

function guest(code: string, files: Record<string, string> = {}): unknown {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/app', { recursive: true });
  for (const [name, text] of Object.entries(files)) vfs.writeFileSync(`/app/${name}`, text);
  return new Runtime(vfs, { cwd: '/app' }).execute(code, '/app/entry.js').exports;
}

describe('path, as Node has it', () => {
  it('is its own posix object, the same through every name', () => {
    expect(guest(`const path = require("path");
      module.exports = [path === require("path/posix"), path.posix === path, path.win32.posix === path, require("node:path/posix") === path, path.win32 === require("path/win32")];`)).toEqual([true, true, true, true, true]);
  });
  it('is mutable, and a patch reaches every name', () => {
    expect(guest(`const path = require("path"); const original = path.join;
      path.join = () => "patched"; const seen = require("path/posix").join("a", "b"); path.join = original;
      module.exports = seen;`)).toBe('patched');
  });
  it('matches globs case-sensitively on the engine, whatever host measures it', () => {
    expect(guest(`const path = require("path"); const fs = require("fs");
      module.exports = [path.matchesGlob("foo.JS", "*.js"), path.matchesGlob("src/foo.js", "SRC/*.js"), path.matchesGlob("src/foo.js", "src/*.js"), fs.globSync(["*.js", "*.ts"]).sort(), fs.globSync("*", { withFileTypes: true }).every((d) => typeof d.isFile === "function")];`,
      { 'a.js': '', 'Foo.TS': '', 'b.ts': '' })).toEqual([false, false, true, ['a.js', 'b.ts', 'entry.js'], true]);
  });
});
