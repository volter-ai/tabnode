/**
 * A prepared module body's name. This module is the derivation's one home and imports nothing, so a host that
 * builds an image and a page that reads one load it as `@volter/tabnode/prepared-key` without the engine; the
 * engine's loader names bodies by the same functions.
 */

/** The key derivation's own name: part of every key, and of the name of any store that keeps bodies by key. */
export const PREPARED_MODULES_FORMAT = 'tabnode-prepared-5';
/** The list, in the bodies' directory, of the keys of bodies prepared and kept where they run: one a line. No body has this name. */
export const PREPARED_MODULES_KEPT = '.kept';
/** How a file is compiled, which is part of its body's name: undefined for a file no body is prepared for. */
export function preparedModuleKind(resolvedPath: string): 'js' | 'cjs' | undefined {
  const extension = /\.(js|cjs|mjs)$/u.exec(resolvedPath)?.[1];
  // Node also loads extensionless JavaScript executables (for example a
  // package's bin entry). Their preparation is identical to ordinary JS.
  const extensionless = !resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1).includes('.');
  if (!extension && !extensionless) return undefined;
  return extension === 'cjs' ? 'cjs' : 'js';
}
/**
 * The name a prepared body goes under, from the plain SHA-256 of the file's bytes (64 lowercase hex): the format,
 * how the file is compiled, and that digest, as text. A tree that holds its files' digests names a body without
 * the file being read; where the image is built and in the tab it is this one function.
 */
export function preparedModuleKeyOf(kind: 'js' | 'cjs', contentSha256: string): string {
  return `${PREPARED_MODULES_FORMAT}.${kind}.${contentSha256}`;
}
/** Whether a name is a prepared body's, of this format. */
export function isPreparedModuleKey(name: string): boolean {
  return name.startsWith(`${PREPARED_MODULES_FORMAT}.`) && /^\.(?:js|cjs)\.[0-9a-f]{64}$/u.test(name.slice(PREPARED_MODULES_FORMAT.length));
}
