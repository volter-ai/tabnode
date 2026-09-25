/**
 * Tarball Extractor
 * Downloads and extracts npm package tarballs into the virtual file system
 */

import { refuseInstall } from './install-trap';
import pako from 'pako';
import { VirtualFS } from '../virtual-fs';
import * as path from '../shims/path';

export interface ExtractOptions {
  stripComponents?: number; // Number of leading path components to strip (default: 1 for npm's "package/" prefix)
  filter?: (path: string) => boolean;
  onProgress?: (message: string) => void;
}

interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'unknown';
  size: number;
  mode: number;
  content?: Uint8Array;
  linkTarget?: string;
}

/**
 * Parse a tar archive from raw bytes
 */
function* parseTar(data: Uint8Array): Generator<TarEntry> {
  const decoder = new TextDecoder();
  let offset = 0;
  // The name a pax extended header or a GNU long-name entry gave the entry
  // that follows it.
  let __nextName: string | undefined;

  while (offset < data.length - 512) {
    // Read 512-byte header
    const header = data.slice(offset, offset + 512);
    offset += 512;

    // Check for end of archive (two zero blocks)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const name = parseString(header, 0, 100);
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]);
    const linkName = parseString(header, 157, 100);
    const prefix = parseString(header, 345, 155);

    // Skip empty entries
    if (!name) {
      continue;
    }

    // Combine prefix and name for long paths
    const fullName = __nextName !== void 0 ? __nextName : prefix ? `${prefix}/${name}` : name;
    __nextName = void 0;

    // Determine entry type
    let type: TarEntry['type'];
    switch (typeFlag) {
      case '0':
      case '\0':
      case '':
        type = 'file';
        break;
      case '5':
        type = 'directory';
        break;
      case '1':
      case '2':
        type = 'symlink';
        break;
      default:
        type = 'unknown';
    }

    // Read file content (empty files get an empty Uint8Array)
    let content: Uint8Array | undefined;
    // Every entry's payload is skipped, not a file entry's only: an entry of
    // another kind that carries one — the pax extended header npm's older
    // tarballs put before every file — left its payload in place and the next
    // header was read out of it. serve-favicon 2.5.0 came out of the store as
    // files named by lines of its README and no package.json.
    const __payload = size > 0 ? Math.ceil(size / 512) * 512 : 0;
    if (typeFlag === "x" || typeFlag === "L") {
      const __text = new TextDecoder().decode(data.slice(offset, offset + size));
      offset += __payload;
      if (typeFlag === "L") {
        __nextName = __text.replace(/\0+$/, "");
      } else {
        for (const __line of __text.split("\n")) {
          const __match = /^\d+ path=(.*)$/.exec(__line);
          if (__match) __nextName = __match[1];
        }
      }
      continue;
    }
    if (type === 'file') {
      content = size > 0 ? data.slice(offset, offset + size) : new Uint8Array(0);
    }
    offset += __payload;

    yield {
      name: fullName,
      type,
      size,
      mode,
      content,
      linkTarget: type === 'symlink' ? linkName : undefined,
    };
  }
}

/**
 * Parse a null-terminated string from tar header
 */
function parseString(data: Uint8Array, offset: number, length: number): string {
  const bytes = data.slice(offset, offset + length);
  const nullIndex = bytes.indexOf(0);
  const actualBytes = nullIndex >= 0 ? bytes.slice(0, nullIndex) : bytes;
  return new TextDecoder().decode(actualBytes);
}

/**
 * Parse an octal number from tar header
 */
function parseOctal(data: Uint8Array, offset: number, length: number): number {
  const str = parseString(data, offset, length).trim();
  return parseInt(str, 8) || 0;
}

/**
 * Decompress gzipped data
 */
export function decompress(data: ArrayBuffer | Uint8Array): Uint8Array {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  return pako.inflate(input);
}

/**
 * Extract a tarball to the virtual file system
 */
export function extractTarball(
  tarballData: ArrayBuffer | Uint8Array,
  vfs: VirtualFS,
  destPath: string,
  options: ExtractOptions = {}
): string[] {
  refuseInstall({ door: 'tarball extraction', subject: 'an npm tarball would be extracted in the tab' });
  const { stripComponents = 1, filter, onProgress } = options;

  // Decompress gzip
  onProgress?.('Decompressing...');
  const tarData = decompress(tarballData);

  // Parse and extract tar entries
  const extractedFiles: string[] = [];

  for (const entry of parseTar(tarData)) {
    // Skip non-file/directory entries for now
    if (entry.type !== 'file' && entry.type !== 'directory') {
      continue;
    }

    // Strip leading path components (npm packages have "package/" prefix)
    let entryPath = entry.name;
    if (stripComponents > 0) {
      const parts = entryPath.split('/').filter(Boolean);
      if (parts.length <= stripComponents) {
        continue;
      }
      entryPath = parts.slice(stripComponents).join('/');
    }

    // Apply filter if provided
    if (filter && !filter(entryPath)) {
      continue;
    }

    // Build destination path
    const fullPath = path.join(destPath, entryPath);

    if (entry.type === 'directory') {
      vfs.mkdirSync(fullPath, { recursive: true });
    } else if (entry.type === 'file' && entry.content) {
      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      vfs.mkdirSync(parentDir, { recursive: true });

      // Write file
      vfs.writeFileSync(fullPath, entry.content);
      extractedFiles.push(fullPath);
    }
  }

  onProgress?.(`Extracted ${extractedFiles.length} files`);

  return extractedFiles;
}

/**
 * Download and extract a tarball from URL
 */
// The store's hook gets the engine's own extractor for a package it must fetch.
(globalThis as Record<symbol, unknown>)[Symbol.for("@volter/browser-runtime/package-extract")] = extractTarball;

/** Run `work` over `items` with `size` of them in flight, each lane taking the next. */
export async function __browserRuntimeInstallPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]);
    }
  }));
}

export async function downloadAndExtract(
  url: string,
  vfs: VirtualFS,
  destPath: string,
  options: ExtractOptions = {}
): Promise<string[]> {
  refuseInstall({ door: 'tarball download', subject: url });
  const { onProgress } = options;

  onProgress?.(`Downloading ${url}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status}`);
  }

  const data = await response.arrayBuffer();

  return extractTarball(data, vfs, destPath, options);
}

export default {
  decompress,
  extractTarball,
  downloadAndExtract,
};
