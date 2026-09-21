/**
 * `child_process`, as Node's own `lib/child_process.js`.
 *
 * What died: the engine's `child_process` was hand-written, and between fork
 * .36 and .44 it took correction after correction -- `fork`'s path
 * resolution, `kill` on an exited child, `send` with a handle, uncaught
 * exceptions, `unhandledRejection`'s promise -- each one a gap of Node's
 * behaviour that an application met in the tab, and the application at the end
 * of that run, VS Code's extension host, still did not activate an extension.
 * A hand-written module carries only the slice of Node that one program
 * exercised. Node's own `test-child-process-*`: 52 of 109 passed.
 *
 * What this is: Node's `lib/child_process.js` and `lib/internal/child_process.js`
 * v22.18.0, vendored unmodified, loaded by `./load.ts` on the binding in
 * `./binding/` -- `process_wrap`, `spawn_sync`, `tty_wrap` and the IPC flavour
 * of `pipe_wrap`, which start, end and pipe a run and nothing else.
 * `ChildProcess`, `spawn`, `exec`, `execFile`, `fork`, `spawnSync`,
 * `execSync`, `send` with a handle and `kill` are Node's own code.
 *
 * The rule for this file: it binds, it does not implement. A `child_process`
 * bug is fixed in the binding or in the engine's process model
 * (`src/shims/child_process.ts`), never by editing either vendored file.
 */
import { loadNodeLib } from './load';

/** Node's `child_process` module object, as a program receives it. */
export interface ChildProcessModule {
  ChildProcess: new () => unknown;
  spawn: (...args: unknown[]) => unknown;
  spawnSync: (...args: unknown[]) => unknown;
  exec: (...args: unknown[]) => unknown;
  execSync: (...args: unknown[]) => unknown;
  execFile: (...args: unknown[]) => unknown;
  execFileSync: (...args: unknown[]) => unknown;
  fork: (...args: unknown[]) => unknown;
  _forkChild: (fd: number, serializationMode: string) => void;
}

/** The loaded module: Node's own `child_process.js`, evaluated once. */
export const childProcessModule = loadNodeLib('child_process') as unknown as ChildProcessModule;

/**
 * `setupChannel` from Node's `internal/child_process.js`: what wires one end
 * of an IPC channel onto a process object. The parent's end is wired by
 * `ChildProcess.prototype.spawn`; the child's is wired by the engine's `node`
 * command, which is this engine's `lib/internal/process/pre_execution.js`.
 */
export interface ChannelControl {
  refCounted(): void;
  unrefCounted(): void;
}
interface InternalChildProcess {
  setupChannel(target: unknown, channel: unknown, serializationMode: string): ChannelControl;
}
export function setupChannel(target: unknown, channel: unknown, serializationMode: string): ChannelControl {
  return (loadNodeLib('internal/child_process') as unknown as InternalChildProcess)
    .setupChannel(target, channel, serializationMode);
}
