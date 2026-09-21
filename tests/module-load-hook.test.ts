// A program that replaces `Module._load` sees every require after it.
//
// Node's chain is `require(id)` -> `Module.prototype.require` ->
// `Module._load(request, parent, isMain)` -> resolve and load, so replacing
// `_load` intercepts every later require. That is how ts-node, pirates,
// module-alias and proxyquire work, and it is how openvscode-server's
// extension host answers an extension's `require('vscode')`:
// `NodeModuleRequireInterceptor` takes `const t = require('module'), i =
// t._load` and puts its own function in its place.
//
// The engine's require went straight to its own loader, so the patch was
// installed and never called: measured in the substrate's tab on
// v0.2.14-volter.64, `module._load = fn; require('fs')` left `fn` unseen,
// and no extension in the tab could ever have been handed the `vscode` API.
import { describe, expect, it } from 'vitest';
import { VirtualFS, createContainer } from '../src/index';

describe('a replaced Module._load', () => {
  it('answers an extension’s require, as the extension host’s interceptor does', async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/work', { recursive: true });
    vfs.writeFileSync('/work/package.json', JSON.stringify({ name: 'work' }));
    // What an extension's main looks like.
    vfs.writeFileSync('/work/extension.js',
      "const vscode = require('vscode');\n"
      + "module.exports.activate = () => vscode.window.name;\n");
    vfs.writeFileSync('/work/host.js',
      "const m = require('module');\n"
      + "const inner = m._load;\n"
      + "const seen = [];\n"
      + "m._load = function (request, parent, isMain) {\n"
      + "  seen.push(request);\n"
      + "  if (request === 'vscode') return { window: { name: 'the api' } };\n"
      + "  return inner.apply(this, arguments);\n"
      + "};\n"
      + "const ext = require('/work/extension.js');\n"
      + "console.log('seen ' + seen.join(','));\n"
      + "console.log('activate ' + ext.activate());\n"
      + "console.log('builtin still works ' + (typeof require('path').join));\n");
    const seen = await createContainer({ vfs }).run('node /work/host.js', { cwd: '/work' });
    expect(seen.stdout).toContain('activate the api');
    expect(seen.stdout).toMatch(/seen .*\/work\/extension\.js/);
    expect(seen.stdout).toMatch(/seen .*vscode/);
    expect(seen.stdout).toContain('builtin still works function');
    expect(seen.exitCode).toBe(0);
  }, 20_000);
});
