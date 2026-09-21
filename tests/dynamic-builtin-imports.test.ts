// A package that is already CommonJS still reaches Node's builtins through
// `import("...")`, and in a tab that call is the browser's own import, which
// fails on a bare specifier. The transformer lowers those to `require`. It
// kept one list of builtin names per lowering path, and the already-CommonJS
// path's list had never been given the subpath builtins, `stream/web` or
// `constants`, so a pre-bundled package's `import("fs/promises")` went to the
// browser untouched.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Runtime, VirtualFS } from '../src/index';
import { transformPackage } from '../src/transform';

// Already CommonJS: no static import or export anywhere, so the transformer
// takes it down the dynamic-import patching path and not the ESM one.
const PACKAGE = `
module.exports = async function seen() {
  const promises = await import("fs/promises");
  const web = await import("stream/web");
  const table = await import("constants");
  const children = await import("child_process");
  const platform = await import("node:os");
  const consumers = await import('stream/consumers');
  const types = await import("util/types");
  return {
    readFile: typeof promises.readFile,
    ReadableStream: typeof web.ReadableStream,
    O_RDONLY: typeof table.O_RDONLY,
    execSync: typeof children.execSync,
    platform: typeof platform.platform,
    text: typeof consumers.text,
    isDate: typeof types.isDate,
  };
};
`;

async function engineAnswers(): Promise<unknown> {
  const vfs = new VirtualFS();
  vfs.mkdirSync('/pkg', { recursive: true });
  vfs.writeFileSync('/pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0' }));
  vfs.writeFileSync('/pkg/index.js', PACKAGE);
  const transformed = await transformPackage(vfs, '/pkg');
  const text = vfs.readFileSync('/pkg/index.js', 'utf8') as string;
  const runtime = new Runtime(vfs, { cwd: '/pkg' });
  const seen = runtime.runFile('/pkg/index.js').exports as () => Promise<unknown>;
  return { transformed, left: text.match(/\bimport\s*\(/g) ?? [], seen: await seen() };
}

/** What Node itself answers for the same file, unlowered. */
function nodeAnswers(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-'));
  writeFileSync(join(dir, 'index.js'), PACKAGE);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, `require("./index.js")().then((seen) => console.log(JSON.stringify(seen)));`);
  const out = execFileSync('/bin/sh', ['-lc', `node ${JSON.stringify(probe)}`], { encoding: 'utf8', env: { HOME: userInfo().homedir } });
  return JSON.parse(out.trim());
}

describe('dynamic imports of Node builtins in an already-CommonJS package', () => {
  it('are all lowered, and answer what Node answers', async () => {
    const engine = await engineAnswers() as { transformed: number; left: string[]; seen: unknown };
    // The file was rewritten, and nothing calling `import(` is left in it.
    expect(engine.transformed).toBe(1);
    expect(engine.left).toEqual([]);
    expect(engine.seen).toEqual(nodeAnswers());
  });
});
