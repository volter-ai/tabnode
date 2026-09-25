/**
 * The engine installs nothing. In the tab a package reaches a project as a
 * pack its image or catalog already carries; resolving from a registry,
 * downloading a tarball and extracting it into node_modules are refused
 * before any of it starts, and the refusal names what was asked for.
 *
 * The consumer (browser-substrate) keeps the same trap in its runtime; both
 * share its error code, its console prefix and its recorder, found by a
 * global symbol, so an image's dry run that listens in the realm hears a
 * refusal from either side.
 */

export interface InstallRequest {
  door: string;
  subject: string;
  detail?: Record<string, string | number | boolean>;
}

export const INSTALL_REFUSED = 'EINSTALLREFUSED';

const RECORDER = Symbol.for('browser-substrate.install-recorder');
const TRAPPED = Symbol.for('browser-substrate.install-trapped');
type TrapGlobal = typeof globalThis & { [RECORDER]?: (request: InstallRequest) => void; [TRAPPED]?: InstallRequest[] };

export class InstallRefusedError extends Error {
  readonly code = INSTALL_REFUSED;
  constructor(readonly request: InstallRequest) {
    super([
      `REFUSED (${request.door}): ${request.subject}`,
      '',
      'The tab never installs, downloads, extracts or builds a dependency. Every package reaches it as a prepared',
      'pack the image or the catalog already carries, and this one was not there. Nothing was attempted.',
      '',
      "To fix it, prepare the image again on a machine, from the project's folder, so its dry run captures this:",
      '',
      '    npx browser-substrate dev',
    ].join('\n'));
    this.name = 'InstallRefusedError';
  }
}

/** Refuses an install before it starts: records it, says so, and throws. */
export function installTrap(request: InstallRequest): never {
  const scope = globalThis as TrapGlobal;
  (scope[TRAPPED] ??= []).push(request);
  scope[RECORDER]?.(request);
  console.error(`[install-trap] ${request.door}: ${request.subject}`);
  throw new InstallRefusedError(request);
}

/**
 * The trap as a statement at the head of the upstream installer's own
 * functions: it throws every time, and the upstream bodies after it stay
 * as they are, so the fork's difference from them is these calls.
 */
export const refuseInstall: (request: InstallRequest) => void = installTrap;
