import { describe, it, expect } from 'vitest';
import { resolveFromPackageJson } from '../src/npm/resolver';

function manifest(name: string, versions: Record<string, Record<string, string>>) {
  const keys = Object.keys(versions);
  return {
    name,
    'dist-tags': { latest: keys[keys.length - 1] },
    versions: Object.fromEntries(keys.map((version) => [version, { name, version, dist: { tarball: `https://registry.example/${name}/-/${name}-${version}.tgz` }, dependencies: versions[version] }])),
  };
}

describe('resolveFromPackageJson', () => {
  it("gives a root dependency its own best version before a dependency's narrower range is met", async () => {
    const docs: Record<string, unknown> = {
      a: manifest('a', { '1.0.0': { react: '>=19 <19.3' } }),
      react: manifest('react', { '19.2.8': {}, '19.3.0': {} }),
      'react-dom': manifest('react-dom', { '19.3.0': { react: '^19.3.0' } }),
    };
    const registry = { getPackageManifest: async (name: string) => docs[name], registryFor: () => 'https://registry.example' };
    const resolved = await resolveFromPackageJson(
      { dependencies: { a: '^1.0.0', react: '^19.2.4', 'react-dom': '^19.2.4' } },
      { registry: registry as never },
    );
    expect(resolved.get('react')?.version).toBe('19.3.0');
    expect(resolved.get('react-dom')?.version).toBe('19.3.0');
    expect(resolved.get('a')?.version).toBe('1.0.0');
  });
});
