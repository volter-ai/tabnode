import { describe, it, expect } from 'vitest';
import { transformEsmToCjsSimple } from '../src/code-transforms';

describe('transformEsmToCjsSimple re-exports', () => {
  const evaluate = (code: string, modules: Record<string, Record<string, unknown>>) => {
    const exports: Record<string, unknown> = {};
    const require = (id: string) => modules[id];
    new Function('exports', 'require', transformEsmToCjsSimple(code))(exports, require);
    return exports;
  };

  it('lets an explicit re-export win over a name a star export brought in first, as the language says', () => {
    const exports = evaluate(
      'export * from "./core.js";\nexport { toZod } from "./util.js";\n',
      { './core.js': { toZod: 'star', other: 1 }, './util.js': { toZod: 'named' } },
    );
    expect(exports.toZod).toBe('named');
    expect(exports.other).toBe(1);
  });

  it('keeps a named re-export a live binding', () => {
    const util: Record<string, unknown> = { value: 1 };
    const exports = evaluate('export { value } from "./util.js";\n', { './util.js': util });
    util.value = 2;
    expect(exports.value).toBe(2);
  });

  it('lets a local export shadow a star export of the same name', () => {
    const exports = evaluate(
      'export * from "./core.js";\nconst fromStream = "local";\nexport { fromStream };\n',
      { './core.js': { fromStream: 'star' } },
    );
    expect(exports.fromStream).toBe('local');
  });

  it('lowers a namespace re-export to one export holding the module', () => {
    const exports = evaluate(
      'export * as util from "./util.js";\nexport * from "./core.js";\n',
      { './util.js': { derived: 1, other: 2 }, './core.js': { core: true } },
    );
    expect((exports.util as { derived: number }).derived).toBe(1);
    expect(exports.derived).toBeUndefined();
    expect(exports.core).toBe(true);
  });

  it('keeps named exports beside a default export, as the namespace Node gives a require', () => {
    const exports = evaluate(
      'export function readdirp(root) { return root; }\nexport const EntryTypes = { FILE: 1 };\nexport default readdirp;\n',
      {},
    );
    expect(typeof exports.readdirp).toBe('function');
    expect(exports.default).toBe(exports.readdirp);
    expect((exports.EntryTypes as { FILE: number }).FILE).toBe(1);
  });

  it('lowers a default expression and an anonymous default class', () => {
    const one = evaluate('const x = 1;\nexport default x + 1;\n', {});
    expect(one.default).toBe(2);
    const two = evaluate('export default class { static tag = "k"; }\n', {});
    expect((two.default as { tag: string }).tag).toBe('k');
    const three = evaluate('export default function () { return 7; }\n', {});
    expect((three.default as () => number)()).toBe(7);
  });
});
