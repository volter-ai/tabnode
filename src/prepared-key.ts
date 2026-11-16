/**
 * A prepared module body's name. This module is the derivation's one home and imports nothing, so a host that
 * builds an image and a page that reads one load it as `@volter/tabnode/prepared-key` without the engine; the
 * engine's loader names bodies by the same functions.
 */

// 9: every free name of a body is rewritten onto its process's scope objects (ADR-0015).
/** The key derivation's own name: part of every key, and of the name of any store that keeps bodies by key. */
export const PREPARED_MODULES_FORMAT = 'tabnode-prepared-9';
/** The list, in the bodies' directory, of the keys of bodies prepared and kept where they run: one a line. No body has this name. */
export const PREPARED_MODULES_KEPT = '.kept';
/**
 * Which realm a body is prepared for (ADR-0018 §7): `guest`, a realm whose processes' free names resolve on their
 * scope objects (ADR-0015), whose bodies are rewritten for them; `node`, the realm whose process is `node`, whose
 * global is the realm's own, whose bodies are compiled as Node compiles them, unrewritten.
 */
export type PreparedModuleForm = 'guest' | 'node';
/** How a file is compiled, which is part of its body's name: undefined for a file no body is prepared for. */
export type PreparedModuleKind = 'js' | 'cjs' | 'node-js' | 'node-cjs';
export function preparedModuleKind(resolvedPath: string, form: PreparedModuleForm = 'guest'): PreparedModuleKind | undefined {
  const extension = /\.(js|cjs|mjs)$/u.exec(resolvedPath)?.[1];
  // Node also loads extensionless JavaScript executables (for example a
  // package's bin entry). Their preparation is identical to ordinary JS.
  const extensionless = !resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1).includes('.');
  if (!extension && !extensionless) return undefined;
  const kind = extension === 'cjs' ? 'cjs' : 'js';
  return form === 'node' ? `node-${kind}` : kind;
}
/**
 * The name a prepared body goes under, from the plain SHA-256 of the file's bytes (64 lowercase hex): the format,
 * how the file is compiled, and that digest, as text. A tree that holds its files' digests names a body without
 * the file being read; where the image is built and in the tab it is this one function.
 */
export function preparedModuleKeyOf(kind: PreparedModuleKind, contentSha256: string): string {
  return `${PREPARED_MODULES_FORMAT}.${kind}.${contentSha256}`;
}
/** Whether a name is a prepared body's, of this format. */
export function isPreparedModuleKey(name: string): boolean {
  return name.startsWith(`${PREPARED_MODULES_FORMAT}.`) && /^\.(?:node-)?(?:js|cjs)\.[0-9a-f]{64}$/u.test(name.slice(PREPARED_MODULES_FORMAT.length));
}
