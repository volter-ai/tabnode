import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { setVFS, __flattenTsconfig } from '../src/shims/esbuild';

// esbuild reports a base config it cannot find as a warning and builds on
// with what the config itself says; TypeScript is the one that errors. A
// project whose tsconfig extends a file its own generator writes — every
// SvelteKit checkout extends `./.svelte-kit/tsconfig.json`, written by
// `svelte-kit sync` when the dev server starts — has that base missing while
// Vite loads its config, and must still load.
describe('tsconfig extends', () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS();
    setVFS(vfs);
  });

  it('keeps the config when a base is missing', () => {
    const flattened = __flattenTsconfig(
      '{ "extends": "./.svelte-kit/tsconfig.json", "compilerOptions": { "target": "es2022" } }',
      '/app'
    );
    expect(flattened.compilerOptions?.target).toBe('es2022');
    expect((flattened as Record<string, unknown>).extends).toBeUndefined();
  });

  it('still inherits from a base that is there', () => {
    vfs.writeFileSync('/app/.svelte-kit/tsconfig.json', '{ "compilerOptions": { "module": "esnext", "target": "es2017" } }');
    const flattened = __flattenTsconfig(
      '{ "extends": "./.svelte-kit/tsconfig.json", "compilerOptions": { "target": "es2022" } }',
      '/app'
    );
    expect(flattened.compilerOptions?.module).toBe('esnext');
    expect(flattened.compilerOptions?.target).toBe('es2022');
  });

  it('applies the bases it finds when one of several is missing', () => {
    vfs.writeFileSync('/app/base.json', '{ "compilerOptions": { "module": "esnext" } }');
    const flattened = __flattenTsconfig(
      '{ "extends": ["./missing.json", "./base.json"], "compilerOptions": { "target": "es2022" } }',
      '/app'
    );
    expect(flattened.compilerOptions?.module).toBe('esnext');
    expect(flattened.compilerOptions?.target).toBe('es2022');
  });
});
