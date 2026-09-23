import type { ProcessIdentity } from './process-registry';
import type { NativeStreamDescriptor } from './native-stream-owner';
import type { RunStreams } from './shims/child_process';
import type { VirtualFS } from './virtual-fs';

/** Trusted launch data, before Node options or the script execute in a realm. */
export interface NodeProcessLaunch {
  token: string;
  identity: ProcessIdentity;
  /** Arguments after the Node executable, preserving each parsed word. */
  argv: readonly string[];
  cwd: string;
  /** This entry's filesystem view, including any host-prepared entry wrapper. */
  filesystem: VirtualFS;
  env: Record<string, string>;
  stdin?: string;
  streams?: RunStreams;
  inherited: readonly { fd: number; handle: NativeStreamDescriptor }[];
}

export interface NodeProcessHost {
  run(launch: NodeProcessLaunch): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

let host: NodeProcessHost | undefined;
let installed = false;
let started = false;
let localToken: string | undefined;
let localStarted = false;

/** Host bootstrap only. A process worker admits exactly one local Node entry. */
export function installNodeProcessHost(next: NodeProcessHost, token?: string): void {
  if (installed || started) throw new Error('Node process host must be installed once before Node execution.');
  if (typeof next?.run !== 'function' || (token !== undefined && (typeof token !== 'string' || !token.length))) {
    throw new Error('Invalid Node process host.');
  }
  host = next;
  localToken = token;
  installed = true;
}

/** Called by the common Node command entry, including engine-first forks. */
export function nodeProcessHostFor(token: string | null): NodeProcessHost | undefined {
  started = true;
  if (!host) return undefined;
  if (token === null) throw new Error('Isolated Node execution requires a named run.');
  if (token !== localToken) return host;
  if (localStarted) throw new Error('This worker has already executed its admitted Node process.');
  localStarted = true;
  return undefined;
}
