/**
 * A `.ts`, `.mts` or `.cts` module's types erased the way Node's loader erases
 * them: `Module.prototype._compile` hands the source to
 * `stripTypeScriptModuleTypes` of Node's own `internal/modules/typescript.js`
 * (vendored, unmodified), which runs amaro in strip-only mode -- types become
 * whitespace, so every line and column stays where the file has it -- refuses
 * `enum`, `namespace` with values, parameter properties and the rest with
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and refuses any file under
 * `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
 *
 * The file is the process's own, from the process's builtin graph: Node reads
 * `--experimental-transform-types` once per process (`getLazy`) and emits its
 * experimental warning on that process, which `--no-warnings` silences. The
 * options a run was started with are answered for the length of the call;
 * `--experimental-transform-types` implies `--enable-source-maps`, as Node's
 * option table says.
 */
import { loadNodeLibFor } from './load';
import { withOptionValues } from './internals/runtime';
import { hostAmaro } from './internals/amaro';

interface TypeScriptModule { stripTypeScriptModuleTypes(source: string, filename: string): string }
type RunProcess = { execArgv?: readonly string[]; env?: Record<string, string | undefined> };

/** Whether this realm can erase types itself: amaro is loadable here. */
export function canStripTypes(): boolean {
  return hostAmaro() !== null;
}

/** Whether a process was started with an option, on its command line or in `NODE_OPTIONS` (both options here are allowed there). */
function startedWith(process: RunProcess, option: string): boolean {
  if (Array.isArray(process.execArgv) && process.execArgv.includes(option)) return true;
  const nodeOptions = process.env?.NODE_OPTIONS;
  return typeof nodeOptions === 'string' && nodeOptions.split(/\s+/u).includes(option);
}

/** Whether a process transforms TypeScript-only syntax rather than refusing it. */
export function transformsTypes(process: RunProcess): boolean {
  return startedWith(process, '--experimental-transform-types');
}

/** The module's source with its types erased (or, under `--experimental-transform-types`, transformed), for this process. */
export function stripModuleTypes(source: string, filename: string, process: object): string {
  const typescript = loadNodeLibFor(process, 'internal/modules/typescript') as TypeScriptModule;
  const transform = transformsTypes(process as RunProcess);
  return withOptionValues({
    '--experimental-transform-types': transform,
    '--enable-source-maps': transform || startedWith(process as RunProcess, '--enable-source-maps'),
  }, () => typescript.stripTypeScriptModuleTypes(source, filename));
}
