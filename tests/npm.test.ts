import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import {
  parseVersion,
  compareVersions,
  satisfies,
  findBestVersion,
} from '../src/npm/resolver';
import { extractTarball, decompress } from '../src/npm/tarball';
import { parsePackageSpec, PackageManager } from '../src/npm';
import pako from 'pako';

describe('npm', () => {
  describe('semver', () => {
    describe('parseVersion', () => {
      it('should parse standard versions', () => {
        expect(parseVersion('1.2.3')).toEqual({
          major: 1,
          minor: 2,
          patch: 3,
          prerelease: undefined,
        });
      });

      it('should parse prerelease versions', () => {
        expect(parseVersion('1.0.0-alpha.1')).toEqual({
          major: 1,
          minor: 0,
          patch: 0,
          prerelease: 'alpha.1',
        });
      });

      it('should return null for invalid versions', () => {
        expect(parseVersion('invalid')).toBeNull();
        expect(parseVersion('1.2')).toBeNull();
        expect(parseVersion('v1.2.3')).toBeNull();
      });
    });

    describe('compareVersions', () => {
      it('should compare major versions', () => {
        expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
        expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
      });

      it('should compare minor versions', () => {
        expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
        expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0);
      });

      it('should compare patch versions', () => {
        expect(compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
        expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
      });

      it('should return 0 for equal versions', () => {
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
      });

      it('should rank prerelease lower than release', () => {
        expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
        expect(compareVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
      });
    });

    describe('satisfies', () => {
      it('should match exact versions', () => {
        expect(satisfies('1.2.3', '1.2.3')).toBe(true);
        expect(satisfies('1.2.3', '1.2.4')).toBe(false);
      });

      it('should match caret ranges', () => {
        expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
        expect(satisfies('1.9.9', '^1.0.0')).toBe(true);
        expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
        expect(satisfies('0.9.0', '^1.0.0')).toBe(false);
      });

      it('should match tilde ranges', () => {
        expect(satisfies('1.2.3', '~1.2.0')).toBe(true);
        expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
        expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
      });

      it('should match >= ranges', () => {
        expect(satisfies('1.2.3', '>=1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '>=1.0.0')).toBe(true);
        expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);
      });

      it('should match > ranges', () => {
        expect(satisfies('1.0.1', '>1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '>1.0.0')).toBe(false);
      });

      it('should match <= ranges', () => {
        expect(satisfies('1.0.0', '<=1.0.0')).toBe(true);
        expect(satisfies('0.9.9', '<=1.0.0')).toBe(true);
        expect(satisfies('1.0.1', '<=1.0.0')).toBe(false);
      });

      it('should match < ranges', () => {
        expect(satisfies('0.9.9', '<1.0.0')).toBe(true);
        expect(satisfies('1.0.0', '<1.0.0')).toBe(false);
      });

      it('should match * and latest', () => {
        expect(satisfies('1.0.0', '*')).toBe(true);
        expect(satisfies('999.0.0', '*')).toBe(true);
        expect(satisfies('1.0.0', 'latest')).toBe(true);
      });

      it('should match || ranges', () => {
        expect(satisfies('1.0.0', '1.0.0 || 2.0.0')).toBe(true);
        expect(satisfies('2.0.0', '1.0.0 || 2.0.0')).toBe(true);
        expect(satisfies('3.0.0', '1.0.0 || 2.0.0')).toBe(false);
      });

      it('should match hyphen ranges', () => {
        expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('1.0.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('2.0.0', '1.0.0 - 2.0.0')).toBe(true);
        expect(satisfies('2.0.1', '1.0.0 - 2.0.0')).toBe(false);
      });

      it('should skip prerelease versions by default', () => {
        expect(satisfies('1.0.0-alpha', '^1.0.0')).toBe(false);
      });
    });

    describe('findBestVersion', () => {
      const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0'];

      it('should find highest matching version for caret', () => {
        expect(findBestVersion(versions, '^1.0.0')).toBe('1.2.0');
      });

      it('should find highest matching version for tilde', () => {
        expect(findBestVersion(versions, '~1.0.0')).toBe('1.0.0');
        expect(findBestVersion(versions, '~1.1.0')).toBe('1.1.0');
      });

      it('should return null if no match', () => {
        expect(findBestVersion(versions, '^3.0.0')).toBeNull();
      });
    });
  });

  describe('parsePackageSpec', () => {
    it('should parse package name only', () => {
      expect(parsePackageSpec('express')).toEqual({ name: 'express' });
    });

    it('should parse package with version', () => {
      expect(parsePackageSpec('express@4.18.2')).toEqual({
        name: 'express',
        version: '4.18.2',
      });
    });

    it('should parse scoped package', () => {
      expect(parsePackageSpec('@types/node')).toEqual({
        name: '@types/node',
      });
    });

    it('should parse scoped package with version', () => {
      expect(parsePackageSpec('@types/node@18.0.0')).toEqual({
        name: '@types/node',
        version: '18.0.0',
      });
    });

    it('should parse version ranges', () => {
      expect(parsePackageSpec('express@^4.0.0')).toEqual({
        name: 'express',
        version: '^4.0.0',
      });
    });
  });

  describe('tarball extraction', () => {
    it('should decompress gzipped data', () => {
      const original = new TextEncoder().encode('hello world');
      const compressed = pako.gzip(original);
      const decompressed = decompress(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe('hello world');
    });

    // The engine installs nothing: extracting an npm tarball into the tree is refused before it starts.
    it('refuses to extract a tarball', () => {
      const vfs = new VirtualFS();
      const compressed = pako.gzip(createMinimalTarball({ 'package/package.json': '{"name":"test","version":"1.0.0"}' }));
      expect(() => extractTarball(compressed, vfs, '/node_modules/test')).toThrow(/REFUSED \(tarball extraction\)/);
      expect(vfs.existsSync('/node_modules/test/package.json')).toBe(false);
    });
  });

  describe('PackageManager', () => {
    let vfs: VirtualFS;
    let pm: PackageManager;

    beforeEach(() => {
      vfs = new VirtualFS();
      pm = new PackageManager(vfs);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should list installed packages', () => {
      // Manually set up installed packages
      vfs.writeFileSync(
        '/node_modules/express/package.json',
        '{"name":"express","version":"4.18.2"}'
      );
      vfs.writeFileSync(
        '/node_modules/lodash/package.json',
        '{"name":"lodash","version":"4.17.21"}'
      );

      const packages = pm.list();

      expect(packages).toEqual({
        express: '4.18.2',
        lodash: '4.17.21',
      });
    });

    it('should list scoped packages', () => {
      vfs.writeFileSync(
        '/node_modules/@types/node/package.json',
        '{"name":"@types/node","version":"18.0.0"}'
      );

      const packages = pm.list();

      expect(packages).toEqual({
        '@types/node': '18.0.0',
      });
    });

    it('should return empty object when no packages installed', () => {
      expect(pm.list()).toEqual({});
    });

    // The engine installs nothing: no registry is asked and nothing is written.
    it('refuses to install a package', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(pm.install('tiny-pkg')).rejects.toMatchObject({ code: 'EINSTALLREFUSED' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vfs.existsSync('/node_modules/tiny-pkg')).toBe(false);
    });

    it('refuses to install from package.json', async () => {
      vfs.writeFileSync('/package.json', '{"name":"app","dependencies":{"tiny-pkg":"^1.0.0"}}');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(pm.installFromPackageJson()).rejects.toMatchObject({ code: 'EINSTALLREFUSED' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

/**
 * Create a minimal tar archive for testing
 */
function createMinimalTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBytes = encoder.encode(content);

    // Create 512-byte header
    const header = new Uint8Array(512);

    // Filename (0-100)
    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);

    // File mode (100-108) - octal "0000644\0"
    header.set(encoder.encode('0000644\0'), 100);

    // UID (108-116) - octal "0000000\0"
    header.set(encoder.encode('0000000\0'), 108);

    // GID (116-124) - octal "0000000\0"
    header.set(encoder.encode('0000000\0'), 116);

    // Size (124-136) - octal, 11 digits + space
    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);

    // Mtime (136-148) - octal "00000000000\0"
    header.set(encoder.encode('00000000000\0'), 136);

    // Initially set checksum field to spaces for calculation
    header.set(encoder.encode('        '), 148);

    // Type flag (156) - '0' for regular file
    header[156] = 48; // '0'

    // Calculate checksum (sum of all bytes in header)
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    // Write checksum as 6 octal digits + null + space
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    chunks.push(header);

    // Add content padded to 512-byte boundary
    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const paddedContent = new Uint8Array(paddedSize);
    paddedContent.set(contentBytes);
    chunks.push(paddedContent);
  }

  // Add two 512-byte blocks of zeros to mark end of archive
  chunks.push(new Uint8Array(1024));

  // Concatenate all chunks
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
