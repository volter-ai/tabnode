import type { VirtualFS } from '../virtual-fs';
import { dirname, resolve } from '../shims/path';

const HOST_MARKER = '\0Volter-host-executable-v1\n';
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** The installed npm's metadata, never this engine's or the application's version. */
export function installedNpmVersion(tree: VirtualFS, cwd: string, environment: Record<string, string>, executable = 'npm'): string {
  const paths = executable.includes('/') ? [resolve(cwd, executable)]
    : (environment.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').map(directory => resolve(cwd, directory || '.', executable));
  const installations = new Map<string, string>();
  const manifests = new Set<string>();

  const readManifest = (file: string, cli?: string): boolean => {
    if (!tree.existsSync(file)) return false;
    const path = tree.realpathSync(file);
    if (manifests.has(path)) return installations.has(path);
    manifests.add(path);
    const manifest = JSON.parse(tree.readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown; bin?: unknown };
    if (manifest.name !== 'npm') return false;
    const bin = typeof manifest.bin === 'string' ? manifest.bin
      : manifest.bin !== null && typeof manifest.bin === 'object' ? (manifest.bin as Record<string, unknown>).npm : undefined;
    if (typeof bin !== 'string' || !bin || bin.startsWith('/')) throw new Error(`npm manifest ${path} has no relative npm bin`);
    const directory = dirname(path);
    const target = tree.realpathSync(resolve(directory, bin));
    if (!target.startsWith(`${directory}/`) || !tree.statSync(target).isFile() || (cli !== undefined && target !== cli)) {
      throw new Error(`npm manifest ${path} does not identify its installed npm CLI`);
    }
    if (tree.statSync(target).size <= 256 && tree.readFileSync(target, 'utf8').startsWith(HOST_MARKER)) {
      throw new Error(`npm manifest ${path} names a host marker instead of an installed npm CLI`);
    }
    if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) throw new Error(`npm manifest ${path} has no valid version`);
    installations.set(path, manifest.version);
    return true;
  };

  let markerFound = false;
  for (const file of paths) {
    if (!tree.existsSync(file)) continue;
    const cli = tree.realpathSync(file);
    if (!tree.statSync(cli).isFile()) throw new Error(`npm entry ${file} is not a regular file`);
    // Host markers are bounded files. Do not read a CLI body just to inspect
    // its first bytes; its package/bin relationship supplies that identity.
    const stat = tree.statSync(cli);
    if (stat.size <= 256 && tree.readFileSync(cli, 'utf8').startsWith(HOST_MARKER)) {
      markerFound = true;
      continue;
    }
    let found = false;
    for (let directory = dirname(cli); ; directory = dirname(directory)) {
      if (readManifest(resolve(directory, 'package.json'), cli)) {
        found = true;
        if (!markerFound) return installations.values().next().value!;
        break;
      }
      if (directory === '/') break;
    }
    if (!found) throw new Error(`npm entry ${file} has no matching installed npm package.json`);
  }

  if (markerFound) {
    // npm's global Unix layout is {prefix}/lib/node_modules/npm. Catalog
    // aliases replace bin/npm, not evidence of which npm the image shipped.
    // Inspect all PATH prefixes and demand a single real manifest/bin pair;
    // an unrelated project node_modules/npm is never a version provider.
    for (const file of paths) {
      if (dirname(file).split('/').pop() !== 'bin') continue;
      readManifest(resolve(dirname(file), '../lib/node_modules/npm/package.json'));
    }
  }
  if (installations.size !== 1) throw new Error(installations.size > 1
    ? `npm version is ambiguous: the image holds ${[...installations.keys()].join(', ')}`
    : 'npm version is unavailable: the image holds no matching npm package.json and CLI; this engine bundles no npm package');
  return installations.values().next().value!;
}
