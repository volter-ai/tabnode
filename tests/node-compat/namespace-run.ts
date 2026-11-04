/**
 * Acting as a run of a container in a network namespace does (src/process-tokens.ts installRunNetwork): every socket,
 * lookup and interface list the run makes, and every continuation of it, is in that namespace, as a container's run is.
 */
import { enterRun, forgetRunNetwork, installRunNetwork } from '../../src/process-tokens';
import type { NetworkNamespace } from '../../src/network-namespace';

let runs = 0;

export async function inside<T>(network: NetworkNamespace, act: () => T | Promise<T>): Promise<T> {
  const token = `namespace-test-${++runs}`;
  installRunNetwork(token, network);
  try { return await enterRun(token, act); } finally { forgetRunNetwork(token); }
}
