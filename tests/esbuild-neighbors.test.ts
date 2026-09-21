/**
 * The `neighbors` build option, answered by the shim rather than by esbuild.
 *
 * A pack build names the packages being built beside it. esbuild has no such
 * option and refuses the whole build when handed one -- "Invalid option in
 * build() call: neighbors" -- so only a realm whose host consumed the option
 * first could build a package at all. The shim owns it: the option becomes a
 * plugin here and is stripped before esbuild sees the options, so a build means
 * the same thing in any realm.
 *
 * The host here is native esbuild, which reads the real disk, so these are the
 * expectations against esbuild itself rather than against a stand-in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as esbuild from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, useHost, type BuildOptions, type BuildResult } from '../src/shims/esbuild';

/** Every options object the host was handed, to read what did and did not cross. */
let optionsSeenByHost: BuildOptions[] = [];
let project: string;

const host = {
  build: (options: BuildOptions): Promise<BuildResult> => {
    optionsSeenByHost.push(options);
    return esbuild.build(options as esbuild.BuildOptions) as unknown as Promise<BuildResult>;
  },
  transform: (code: string, options?: unknown) =>
    esbuild.transform(code, options as esbuild.TransformOptions) as never,
};

/** The text of the single output a bundle with no outdir produces (`<stdout>`). */
function soleOutput(result: BuildResult): string {
  const files = result.outputFiles || [];
  if (files.length !== 1) throw new Error(`expected one output, got ${files.map((o) => o.path).join(', ') || 'none'}`);
  return files[0]!.text;
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'neighbors-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  // Both packages are really on disk, so leaving one external is the option's
  // doing and not a package esbuild could not have found.
  for (const name of ['neighbor-pkg', 'self-pkg']) {
    mkdirSync(join(project, 'node_modules', name), { recursive: true });
    writeFileSync(join(project, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(project, 'node_modules', name, 'index.js'), `export const from_${name.replace('-', '_')} = ${JSON.stringify(name)};\n`);
    writeFileSync(join(project, 'node_modules', name, 'sub.js'), `export const sub = ${JSON.stringify(name + '/sub')};\n`);
  }
  writeFileSync(join(project, 'src', 'local.ts'), `export const local = "local";\n`);
  writeFileSync(
    join(project, 'src', 'index.ts'),
    [
      `import { from_neighbor_pkg } from "neighbor-pkg";`,
      `import { sub } from "neighbor-pkg/sub";`,
      `import { from_self_pkg } from "self-pkg";`,
      `import { local } from "./local";`,
      `import { sep } from "node:path";`,
      `export const all = [from_neighbor_pkg, sub, from_self_pkg, local, sep];`,
    ].join('\n') + '\n',
  );
  writeFileSync(join(project, 'src', 'other.ts'), `export const other = "other";\n`);
  useHost(host);
});

afterAll(() => {
  useHost(null);
  rmSync(project, { recursive: true, force: true });
});

/** The build every case varies: bundled, to memory, over the fixture project. */
function buildOptions(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    entryPoints: [join(project, 'src', 'index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    absWorkingDir: project,
    ...overrides,
  } as BuildOptions;
}

describe('the neighbors build option', () => {
  beforeAll(() => {
    optionsSeenByHost = [];
  });

  it('leaves a neighbor external under the specifier as written, and reports it', async () => {
    const result = await build(buildOptions({ neighbors: { names: ['neighbor-pkg'] } }));

    expect(result.errors).toEqual([]);
    // Every specifier that reached a neighbor comes back, subpath and all.
    expect(result.neighbors).toEqual(['neighbor-pkg', 'neighbor-pkg/sub']);

    const text = soleOutput(result);
    // External means the import survives in the output under the name it was
    // written with, rather than the package's contents being bundled in.
    expect(text).toContain('"neighbor-pkg"');
    expect(text).toContain('"neighbor-pkg/sub"');
    expect(text).not.toContain('from_neighbor_pkg = "neighbor-pkg"');
  });

  it('keeps a specifier named in self inside the build', async () => {
    const result = await build(
      buildOptions({ neighbors: { names: ['neighbor-pkg', 'self-pkg'], self: ['self-pkg'] } }),
    );

    expect(result.errors).toEqual([]);
    // self-pkg is a name too, but this build is OF it: it is neither reported
    // nor left external, and its contents are in the output.
    expect(result.neighbors).toEqual(['neighbor-pkg', 'neighbor-pkg/sub']);
    const text = soleOutput(result);
    expect(text).toContain('from_self_pkg = "self-pkg"');
    expect(text).not.toMatch(/from\s+"self-pkg"/);
  });

  it('does not report a node: builtin or a relative import as a neighbor', async () => {
    const result = await build(
      buildOptions({ neighbors: { names: ['neighbor-pkg', 'node:path', './local'] } }),
    );

    expect(result.errors).toEqual([]);
    expect(result.neighbors).not.toContain('node:path');
    expect(result.neighbors).not.toContain('./local');
    // The relative import is still bundled, whatever the option said.
    expect(soleOutput(result)).toContain('local = "local"');
  });

  it('strips neighbors from the options before the host sees them', async () => {
    optionsSeenByHost = [];
    const result = await build(buildOptions({ neighbors: { names: ['neighbor-pkg'] } }));

    expect(result.errors).toEqual([]);
    expect(optionsSeenByHost).toHaveLength(1);
    const handed = optionsSeenByHost[0] as BuildOptions & Record<string, unknown>;
    // esbuild refuses an option it does not know, so the shim's own option
    // must not be among the ones that cross.
    expect('neighbors' in handed).toBe(false);
    // The plugin the option became does cross, as the shim's own answer.
    expect((handed.plugins || []).map((plugin) => (plugin as { name?: string }).name)).toContain('neighbors');
  });

  it('leaves a build that named no neighbors without the key', async () => {
    const result = await build(
      buildOptions({ entryPoints: [join(project, 'src', 'other.ts')] }),
    );

    expect(result.errors).toEqual([]);
    expect(result.neighbors).toBeUndefined();
  });

  it('keeps the output names of the named entry point form', async () => {
    const result = await build(
      buildOptions({
        entryPoints: { 'pack-entry': join(project, 'src', 'index.ts'), 'pack-other': join(project, 'src', 'other.ts') },
        outdir: join(project, 'out'),
        neighbors: { names: ['neighbor-pkg'] },
      }),
    );

    expect(result.errors).toEqual([]);
    const names = (result.outputFiles || []).map((output) => output.path.slice(output.path.lastIndexOf('/') + 1)).sort();
    expect(names).toEqual(['pack-entry.js', 'pack-other.js']);
    expect(result.neighbors).toEqual(['neighbor-pkg', 'neighbor-pkg/sub']);
  });
});
